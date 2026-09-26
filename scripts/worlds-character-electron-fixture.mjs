#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(repositoryRoot, 'scripts', 'worlds-character-electron-fixture')

export function parseBuildArguments(args) {
  if (args.length !== 1 || args[0] !== '--build-only') {
    throw new Error('Usage: node scripts/worlds-character-electron-fixture.mjs --build-only (Electron is never launched by this command).')
  }
  return { buildOnly: true }
}

/** Build only. A new private temporary directory is always allocated; nothing is overwritten. */
export async function buildWorldsCharacterFixture() {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'modly-worlds-character-ui-'))
  try {
    const shared = { bundle: true, metafile: true, logLevel: 'silent', tsconfig: path.join(repositoryRoot, 'tsconfig.web.json') }
    const builds = await Promise.all([
      build({ ...shared, entryPoints: [path.join(fixtureSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs'), platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'] }),
      build({ ...shared, entryPoints: [path.join(fixtureSource, 'preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs'), platform: 'browser', format: 'cjs', target: 'es2022', external: ['electron'] }),
      build({ ...shared, entryPoints: [path.join(fixtureSource, 'renderer.tsx')], outfile: path.join(outputDirectory, 'renderer.js'), platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } }),
    ])
    await copyFile(path.join(fixtureSource, 'index.html'), path.join(outputDirectory, 'index.html'))
    const outputs = {}
    for (const filename of ['main.cjs', 'preload.cjs', 'renderer.js', 'renderer.css', 'index.html']) {
      const bytes = await readFile(path.join(outputDirectory, filename))
      outputs[filename] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const versions = {}
    for (const name of ['electron', 'esbuild', 'react', 'react-dom']) {
      versions[name] = JSON.parse(await readFile(path.join(repositoryRoot, 'node_modules', name, 'package.json'), 'utf8')).version
    }
    const result = {
      schema: 'modly.worlds-character-ui-build.v1',
      scope: 'source-level-character-authoring',
      execution: 'NOT_RUN',
      builtAt: new Date().toISOString(),
      outputDirectory,
      versions,
      outputs,
      sourceInputs: [...new Set(builds.flatMap((built) => Object.keys(built.metafile.inputs)))].sort(),
      nextCommand: `/usr/bin/timeout --signal=TERM --kill-after=5s 135s env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_PATH -u WAYLAND_DISPLAY /usr/bin/xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' ${JSON.stringify(path.join(repositoryRoot, 'node_modules/electron/dist/electron'))} ${JSON.stringify(path.join(outputDirectory, 'main.cjs'))}`,
    }
    await writeFile(path.join(outputDirectory, 'fixture-build.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    return result
  } catch (error) {
    await writeFile(path.join(outputDirectory, 'build-failure.txt'), String(error)).catch(() => {})
    throw new Error(`Character fixture build failed; evidence retained at ${outputDirectory}`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    parseBuildArguments(process.argv.slice(2))
    console.log(JSON.stringify(await buildWorldsCharacterFixture(), null, 2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
