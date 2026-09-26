#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(repositoryRoot, 'scripts/worlds-graphics-electron-fixture')
export function parseBuildArguments(args) {
  if (args.length === 1 && args[0] === '--build-only') return { buildOnly: true }
  if (args.length === 2 && new Set(args).size === 2 && args.includes('--build-only') && args.includes('--case=supported-runtime')) return { buildOnly: true, case: 'supported-runtime' }
  throw new Error('Usage: node scripts/worlds-graphics-electron-fixture.mjs --build-only [--case=supported-runtime] (never launches Electron).')
}
export function declareGraphicsCase(caseName = 'recovery') {
  if (!['recovery', 'supported-runtime'].includes(caseName)) throw new Error('Unknown graphics fixture case.')
  return { case: caseName, scope: caseName === 'recovery' ? 'source-level-graphics-recovery' : 'small-scene-hardware-context-admission', mainDeadlineMs: 125000, outerDeadlineSeconds: 145 }
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
export async function buildWorldsGraphicsFixture(caseName = 'recovery') {
  const declaration = declareGraphicsCase(caseName)
  if (await realpath(process.cwd()) !== repositoryRoot) throw new Error(`Build-only fixture must run from ${repositoryRoot}.`)
  if (process.env.WORLD_FFMPEG_BUILD_TRUST_FILE) throw new Error('Graphics-only build refuses unrelated inherited WORLD_FFMPEG_BUILD_TRUST_FILE.')
  const outputDirectory = await mkdtemp('/tmp/modly-worlds-graphics-ui-')
  try {
    // Native TS import avoids Vite config-loader temporary writes outside our private output.
    // Reuse the actual production plugins, including the exact guarded Rapier transform.
    const configPath = path.join(repositoryRoot, 'electron.vite.config.ts')
    const { default: appConfig } = await import(pathToFileURL(configPath).href)
    const renderer = appConfig.renderer
    if (!renderer || !Array.isArray(renderer.plugins) || typeof renderer.worker?.plugins !== 'function') throw new Error('Production renderer/Worker plugin contract changed.')
    const sourceIds = new Set([configPath, fileURLToPath(import.meta.url)])
    const trackInputs = () => ({
      name: 'worlds-graphics-fixture-source-evidence',
      load(id) { if (path.isAbsolute(id) && !id.includes('\0')) sourceIds.add(id.split('?')[0]); return null },
    })
    const common = { bundle: true, metafile: true, logLevel: 'silent', tsconfig: path.join(fixtureSource, 'tsconfig.json'), target: 'es2022', external: ['electron'], define: { __GRAPHICS_CASE__: JSON.stringify(caseName) } }
    const builds = await Promise.all([
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs'), platform: 'node', format: 'cjs' }),
      esbuild({ ...common, entryPoints: [path.join(repositoryRoot, 'scripts/worlds-physics-electron-fixture/preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs'), platform: 'browser', format: 'cjs' }),
    ])
    await viteBuild({
      configFile: false, envFile: false, root: fixtureSource, publicDir: false,
      cacheDir: path.join(outputDirectory, 'vite-cache'), base: './', logLevel: 'warn',
      define: { __GRAPHICS_CASE__: JSON.stringify(caseName) },
      resolve: renderer.resolve, plugins: [...renderer.plugins, trackInputs(), ...(caseName === 'supported-runtime' ? [{
        name: 'worlds-positive-private-asset-csp', transformIndexHtml(html) {
          if (html.split("connect-src 'none'").length !== 2) throw new Error('Positive fixture CSP binding changed.')
          return html.replace("connect-src 'none'", 'connect-src http://127.0.0.1:*')
        },
      }] : [])],
      worker: { ...renderer.worker, plugins: () => [...renderer.worker.plugins(), trackInputs()] },
      build: {
        target: renderer.build.target, outDir: path.join(outputDirectory, 'renderer'), emptyOutDir: false,
        minify: false, sourcemap: false, rollupOptions: { input: path.join(fixtureSource, 'index.html') },
      },
    })
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
      schema: 'modly.worlds-graphics-ui-build.v1', ...declaration, execution: 'NOT_RUN',
      builtAt: new Date().toISOString(), outputDirectory, versions, outputs, outputInventory: Object.keys(outputs), sourceInputs, workerFiles,
      productionWorkerEntry: 'src/areas/worlds/runtime/worldPhysics.worker.ts',
      rendererPlugins: renderer.plugins.flat(Infinity).filter(Boolean).map((plugin) => plugin.name),
      workerPlugins: renderer.worker.plugins().flat(Infinity).filter(Boolean).map((plugin) => plugin.name),
      csp: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'",
      nextCommand: `/usr/bin/timeout --signal=TERM --kill-after=5s 145s env -u ELECTRON_RUN_AS_NODE -u ELECTRON_DISABLE_SANDBOX -u NODE_OPTIONS -u NODE_PATH -u WAYLAND_DISPLAY /usr/bin/xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' ${JSON.stringify(path.join(repositoryRoot, 'node_modules/electron/dist/electron'))} ${JSON.stringify(path.join(outputDirectory, 'main.cjs'))}`,
    }
    if (caseName === 'supported-runtime') Object.assign(result, {
      csp: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src http://127.0.0.1:* (runtime exact single asset URL guard)",
      nextCommand: null, operatorPlan: { execution: 'PLAN_ONLY', approvalRequired: 'NEW private visible window on normal physical display; no fallback or GPU/environment workaround.',
        command: `/usr/bin/timeout --signal=TERM --kill-after=5s 145s ${JSON.stringify(path.join(repositoryRoot, 'node_modules/electron/dist/electron'))} ${JSON.stringify(path.join(outputDirectory, 'main.cjs'))}` },
    })
    await writeFile(path.join(outputDirectory, 'fixture-build.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    return result
  } catch (error) {
    await writeFile(path.join(outputDirectory, 'build-failure.txt'), String(error)).catch(() => undefined)
    throw new Error(`Graphics build-only fixture failed; retained evidence: ${outputDirectory}`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const args = parseBuildArguments(process.argv.slice(2)); console.log(JSON.stringify(await buildWorldsGraphicsFixture(args.case ?? 'recovery'), null, 2)) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
