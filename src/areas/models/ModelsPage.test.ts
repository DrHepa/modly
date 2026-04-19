import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const modelsPageEntry = path.join(projectRoot, 'src/areas/models/ModelsPage.tsx')

async function loadModelsPageModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-models-page-'))
  const outfile = path.join(tempDir, 'ModelsPage.bundle.mjs')

  await build({
    entryPoints: [modelsPageEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'zustand'],
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function renderStatusBanner(props: Record<string, unknown>) {
  const { module, cleanup } = await loadModelsPageModule()

  try {
    return renderToStaticMarkup(createElement(module.GitHubInstallStatusBanner, props))
  } finally {
    await cleanup()
  }
}

async function renderHelpCopy() {
  const { module, cleanup } = await loadModelsPageModule()

  try {
    return renderToStaticMarkup(createElement(module.GitHubRepoHelpCopy))
  } finally {
    await cleanup()
  }
}

test('ModelsPage shows bundle-aware success summary and root-or-bundle help copy', async () => {
  const bannerHtml = await renderStatusBanner({
    installResult: {
      success: true,
      status: 'success',
      installed: [
        { extensionId: 'bundle-model', extension: { id: 'bundle-model', type: 'model' }, status: 'success' },
        { extensionId: 'bundle-process', extension: { id: 'bundle-process', type: 'process' }, status: 'success' },
      ],
      failed: [],
      warnings: [],
      reloaded: true,
    },
    ghErr: null,
  })
  const helpHtml = await renderHelpCopy()

  assert.match(bannerHtml, /Installed 2 extensions from this repo\./)
  assert.match(bannerHtml, /2 of 2 children are ready\./)
  assert.match(helpHtml, /legacy root repo/i)
  assert.match(helpHtml, /extensions\/\*/i)
})

test('ModelsPage shows partial bundle summary with installed and failed child counts', async () => {
  const bannerHtml = await renderStatusBanner({
    installResult: {
      success: true,
      status: 'partial',
      installed: [
        { extensionId: 'bundle-process', extension: { id: 'bundle-process', type: 'process' }, status: 'success' },
      ],
      failed: [
        { extensionId: 'broken-model', stage: 'setup', error: 'setup failed' },
        { extensionId: 'broken-process', stage: 'npm', error: 'npm install failed' },
      ],
      warnings: ['broken-model: setup failed', 'broken-process: npm install failed'],
      reloaded: true,
      error: '2 children failed',
    },
    ghErr: null,
  })

  assert.match(bannerHtml, /Installed 1 of 3 extensions from this repo\./)
  assert.match(bannerHtml, /2 children failed\./)
  assert.match(bannerHtml, /broken-model/i)
})

test('ModelsPage keeps atomic install errors global and explicit', async () => {
  const bannerHtml = await renderStatusBanner({
    installResult: {
      success: false,
      status: 'error',
      installed: [],
      failed: [],
      warnings: [],
      reloaded: false,
      error: 'Missing generator.py in extensions/broken-model',
    },
    ghErr: 'Missing generator.py in extensions/broken-model',
  })

  assert.match(bannerHtml, /Installation failed before any extension was added\./)
  assert.match(bannerHtml, /Missing generator\.py in extensions\/broken-model/)
})
