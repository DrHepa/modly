import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const selectorEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldAssetSelector.tsx')

async function loadSelectorModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-world-selector-test-'))
  const outfile = path.join(tempDir, 'WorldAssetSelector.bundle.mjs')
  const result = await build({
    entryPoints: [selectorEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function openableAsset(id: string, name: string, type: string, sourceScope = 'workflows') {
  return {
    id,
    name,
    type,
    sourceScope,
    openable: true,
    workspacePath: `Workflows/${id}.ply`,
    item: {
      id: `world:Workflows/${id}.ply`,
      workspacePath: `Workflows/${id}.ply`,
      url: `Workflows/${id}.ply`,
      kind: 'ply-mesh',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  }
}

test('WorldAssetSelector renders a compact accessible dialog with only name type and openability', async () => {
  const { module, cleanup } = await loadSelectorModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldAssetSelector, {
      open: true,
      assets: [
        openableAsset('fuse', 'Fuse simplified', 'PLY mesh'),
        { id: 'spz', name: 'Gaussian splat', type: 'Unsupported', sourceScope: 'workflows', openable: false, workspacePath: 'Workflows/splat.spz', reason: 'unsupported-spz' },
        openableAsset('hero', 'Hero GLB', 'GLB model', 'exports'),
      ],
      selectedAssetId: 'fuse',
      loading: false,
      opening: false,
      error: null,
      onToggle: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      onSelectAsset: () => undefined,
      onOpenSelected: () => undefined,
    }))

    assert.match(markup, /role="dialog"/)
    assert.match(markup, /aria-label="World asset selector"/)
    assert.match(markup, /role="list"/)
    assert.match(markup, /Fuse simplified/)
    assert.match(markup, /PLY mesh/)
    assert.match(markup, /Ready/)
    assert.match(markup, /Unsupported/)
    assert.match(markup, /Workflows/)
    assert.match(markup, /Exports/)
    assert.doesNotMatch(markup, /metadata|inspector|raw|schema|provenance|details/i)
  } finally {
    await cleanup()
  }
})

test('WorldAssetSelector keeps the overlay compact and disables open when selection is unavailable', async () => {
  const { module, cleanup } = await loadSelectorModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldAssetSelector, {
      open: true,
      assets: [{ id: 'spz', name: 'Gaussian splat', type: 'Unsupported', sourceScope: 'workflows', openable: false, workspacePath: 'Workflows/splat.spz', reason: 'unsupported-spz' }],
      selectedAssetId: 'spz',
      loading: false,
      opening: false,
      error: null,
      onToggle: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      onSelectAsset: () => undefined,
      onOpenSelected: () => undefined,
    }))

    assert.match(markup, /w-\[320px\]/)
    assert.match(markup, /aria-haspopup="dialog"/)
    assert.match(markup, /aria-expanded="true"/)
    assert.match(markup, /disabled=""[^>]*>Open selected asset/)
    assert.doesNotMatch(markup, /<aside|Permanent|Inspector|Metadata|Provenance|Schema|Details/)
  } finally {
    await cleanup()
  }
})
