import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const routesEntry = path.join(projectRoot, 'src/shared/router/routes.tsx')

async function loadRoutesModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), '.tmp-routes-test-'))
  try {
    const outfile = path.join(tempDir, 'routes.bundle.mjs')

    await build({
      entryPoints: [routesEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [{
        name: 'source-anchored-routes',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^react$/ }, (args) => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
          buildApi.onResolve({ filter: /^@areas\// }, async (args) => {
            const result = await buildApi.resolve(
              path.join(projectRoot, 'src/areas', args.path.slice('@areas/'.length)),
              { kind: args.kind, resolveDir: args.resolveDir },
            )
            return result.errors.length ? result : { ...result, external: true }
          })
        },
      }],
    })

    return {
      module: await import(pathToFileURL(outfile).href),
      async cleanup() {
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

test('routes expose worlds as an immersive full-surface lazy page', async () => {
  const { module, cleanup } = await loadRoutesModule()

  try {
    assert.deepEqual(Object.keys(module.ROUTES), ['generate', 'workflows', 'worlds', 'models', 'settings'])
    assert.equal(module.ROUTES.worlds.wrapperClass, 'flex flex-1 overflow-hidden')
    assert.equal(typeof module.ROUTES.worlds.component, 'object')
  } finally {
    await cleanup()
  }
})
