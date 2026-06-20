import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build, type Plugin } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const pageEntry = path.join(projectRoot, 'src/areas/worlds/WorldsPage.tsx')

function stubViewerPlugin(): Plugin {
  return {
    name: 'stub-worlds-viewer',
    setup(buildApi) {
      buildApi.onResolve({ filter: /components\/WorldsViewer\.tsx$/ }, () => ({ path: 'worlds-viewer-stub', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'tsx',
        contents: `
          import React from 'react'
          export function WorldsViewer(props) {
            return <section aria-label="Worlds 3D canvas" data-items={props.items.length} data-unsupported={(props.unsupportedItems || []).length}>Worlds canvas</section>
          }
          export default WorldsViewer
        `,
      }))
    },
  }
}

async function loadPageModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-page-test-'))
  const outfile = path.join(tempDir, 'WorldsPage.bundle.mjs')
  const result = await build({
    entryPoints: [pageEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [stubViewerPlugin()],
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

function asset(id: string, name: string) {
  return {
    id,
    name,
    type: 'PLY mesh',
    sourceScope: 'workflows',
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

test('WorldsPageView renders a dominant integrated canvas with compact selector overlay and no boxed layout', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsPageView, {
      selectorOpen: true,
      assets: [asset('fuse', 'Fuse simplified')],
      selectedAssetId: 'fuse',
      sceneItems: [asset('fuse', 'Fuse simplified').item],
      unsupportedItems: [],
      loadingAssets: false,
      openingAsset: false,
      error: null,
      onToggleSelector: () => undefined,
      onCloseSelector: () => undefined,
      onRefreshAssets: () => undefined,
      onSelectAsset: () => undefined,
      onOpenSelected: () => undefined,
    }))

    assert.match(markup, /<main[^>]*aria-label="Worlds viewer"/)
    assert.match(markup, /aria-label="Worlds 3D canvas"/)
    assert.match(markup, /role="dialog"/)
    assert.match(markup, /Open asset/)
    assert.match(markup, /z-20/)
    assert.match(markup, /data-items="1"/)
    assert.doesNotMatch(markup, /<aside|page card|boxed|Metadata|Inspector|Raw|Schema|Provenance|Details/i)
  } finally {
    await cleanup()
  }
})

test('WorldsPageView keeps empty guidance minimal and selector closed by default', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsPageView, {
      selectorOpen: false,
      assets: [],
      selectedAssetId: null,
      sceneItems: [],
      unsupportedItems: [],
      loadingAssets: false,
      openingAsset: false,
      error: null,
      onToggleSelector: () => undefined,
      onCloseSelector: () => undefined,
      onRefreshAssets: () => undefined,
      onSelectAsset: () => undefined,
      onOpenSelected: () => undefined,
    }))

    assert.doesNotMatch(markup, /Open a workflow world or renderable asset/i)
    assert.doesNotMatch(markup, /role="dialog"/)
    assert.match(markup, /aria-haspopup="dialog"/)
    assert.match(markup, /aria-expanded="false"/)
    assert.doesNotMatch(markup, /metadata|inspector|raw json|schema|provenance|details/i)
  } finally {
    await cleanup()
  }
})

test('WorldsPage does not automatically close the selector after opening an asset', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.doesNotMatch(source, /setUnsupportedItems\(\[\]\)\s*setSelectorOpen\(false\)/)
})
