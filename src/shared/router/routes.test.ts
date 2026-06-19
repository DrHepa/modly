import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const routesEntry = path.join(projectRoot, 'src/shared/router/routes.tsx')

async function loadRoutesModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-routes-test-'))
  const outfile = path.join(tempDir, 'routes.bundle.mjs')

  await build({
    entryPoints: [routesEntry],
    outfile,
    bundle: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [],
  })

  return {
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
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
