import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-ext-store-test-')), 'extensionsStore.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/stores/extensionsStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('extension list keeps an interrupted model in the model store with recovery metadata', () => {
  const { partitionExtensionsByType } = loadModule()
  const pendingModel = {
    type: 'model',
    id: 'pixal3d',
    name: 'Pixal3D',
    trusted: false,
    builtin: false,
    nodes: [{ id: 'generate' }],
    corrupted: true,
    manifestError: 'incomplete',
  }
  const processExtension = {
    type: 'process',
    id: 'mesh-tool',
    name: 'Mesh Tool',
    trusted: false,
    builtin: false,
    entry: 'processor.js',
    nodes: [{ id: 'simplify' }],
  }

  const result = partitionExtensionsByType([pendingModel, processExtension])

  assert.deepEqual(result.modelExtensions, [pendingModel])
  assert.deepEqual(result.processExtensions, [processExtension])
})

test('ownership refresh composes with installed variants and does not replace extension metadata', async (t) => {
  const { useExtensionsStore } = loadModule()
  const extension = {
    type: 'model', id: 'bundle', name: 'Bundle', trusted: false, builtin: false,
    nodes: ['a', 'b'].map((id) => ({
      id, name: id, hfRepo: 'org/base', capabilityId: `bundle/${id}`, bundleId: 'bundle',
      weightOwnerId: 'bundle/private', sharedOwner: true, legacyPaths: ['bundle/a', 'bundle/b'],
      weightVariants: { param: 'quant', default: 'Q4', options: [{ id: 'Q4', label: 'Q4' }] },
      inputs: ['image', 'text'], inputLabels: ['Photo', 'Prompt'], paramDefaults: { enabled: false },
    })),
  }
  const original = globalThis.window
  t.after(() => { globalThis.window = original })
  globalThis.window = { electron: {
    extensions: { list: async () => [extension] },
    model: { isDownloaded: async (id) => id === 'bundle/b', installedWeightVariants: async () => ['Q4'] },
  } }
  await useExtensionsStore.getState().loadExtensions()
  const state = useExtensionsStore.getState()
  assert.deepEqual(state.readyOwnerIds, ['bundle/private'])
  assert.deepEqual(state.installedWeightVariants, { 'bundle/a': ['Q4'], 'bundle/b': ['Q4'] })
  assert.deepEqual(state.modelExtensions, [extension])
  assert.deepEqual(state.modelExtensions[0].nodes[0].inputs, ['image', 'text'])
  assert.deepEqual(state.modelExtensions[0].nodes[0].paramDefaults, { enabled: false })
})
