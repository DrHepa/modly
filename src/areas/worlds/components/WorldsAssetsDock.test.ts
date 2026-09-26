import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const dockEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsAssetsDock.tsx')
const workbenchCss = path.join(projectRoot, 'src/areas/worlds/WorldsWorkbench.css')

async function loadDockModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-assets-dock-test-'))
  const outfile = path.join(tempDir, 'WorldsAssetsDock.bundle.mjs')
  const result = await build({
    entryPoints: [dockEntry],
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
    async cleanup() { await rm(tempDir, { recursive: true, force: true }) },
  }
}

test('asset dock exposes accessible controls for compatible models and audio', async () => {
  const { module, cleanup } = await loadDockModule()
  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsAssetsDock, {
      assets: [
        {
          id: 'hero', name: 'Hero GLB', displayName: 'Hero GLB', type: 'GLB model', sourceScope: 'workflows', capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: [],
          openable: true, workspacePath: 'Workflows/hero.glb',
          item: { id: 'world:Workflows/hero.glb', workspacePath: 'Workflows/hero.glb', url: 'workspace://hero', kind: 'glb', role: 'asset', visible: true, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        },
        {
          id: 'unsafe', name: 'Unsafe GLB', displayName: 'Unsafe GLB', type: 'Unavailable', sourceScope: 'workflows', capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: [],
          openable: false, workspacePath: '../unsafe.glb', reason: 'unsafe',
        },
        {
          id: 'impact', name: 'Impact', displayName: 'Impact', type: 'Audio', sourceScope: 'workflows', state: 'unknown-metadata', previewKind: 'audio', warnings: [],
          openable: true, workspacePath: 'Workflows/Audio/impact.wav', audio: true, audioFormat: 'wav',
        },
      ],
      loading: false,
      addingAssetId: null,
      error: null,
      onRefresh: () => undefined,
      onAddAsset: () => undefined,
    }))

    assert.match(markup, /class="worlds-asset-row"/)
    assert.match(markup, /class="worlds-asset-add"[^>]*aria-label="Add Hero GLB to scene"/)
    assert.match(markup, /aria-label="Attach audio Impact"/)
    assert.match(markup, />Attach audio<\/button>/)
    assert.match(markup, /aria-describedby="modly-tooltip-/)
    assert.doesNotMatch(markup, /aria-label="Unsafe GLB unavailable"/)
    assert.match(markup, /Unsafe path/)

    const css = await readFile(workbenchCss, 'utf8')
    assert.match(css, /\.worlds-asset-add\s*\{[^}]*min-width:\s*32px[^}]*min-height:\s*32px/s)
    assert.match(css, /\.worlds-asset-add:focus-visible/)
  } finally {
    await cleanup()
  }
})
