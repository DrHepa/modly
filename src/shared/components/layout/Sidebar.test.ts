import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const sidebarEntry = path.join(projectRoot, 'src/shared/components/layout/Sidebar.tsx')

function aliasPlugin(): Plugin {
  const resolvePath = (basePath: string): string => {
    if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = `${basePath}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    return basePath
  }

  return {
    name: 'modly-aliases',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length))),
      }))
    },
  }
}

async function loadSidebarModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-sidebar-test-'))
  const outfile = path.join(tempDir, 'Sidebar.bundle.mjs')

  await build({
    entryPoints: [sidebarEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [aliasPlugin()],
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'zustand'],
  })

  return {
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function extractButtonLabels(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*title="([^"]+)"/g)].map((match) => match[1])
}

test('sidebar exposes Worlds navigation after Workflows as a semantic button', async () => {
  const { module, cleanup } = await loadSidebarModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.default))
    const labels = extractButtonLabels(markup)

    assert.deepEqual(labels, ['Generate', 'Workflows', 'Worlds', 'Extensions', 'Settings'])
    assert.equal(labels.filter((label) => label === 'Worlds').length, 1)
    assert.match(markup, /<button[^>]*title="Worlds"/)
  } finally {
    await cleanup()
  }
})
