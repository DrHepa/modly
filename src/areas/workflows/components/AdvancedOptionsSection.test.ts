import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const advancedSectionEntry = path.join(projectRoot, 'src/areas/workflows/components/AdvancedOptionsSection.tsx')

async function loadAdvancedOptionsSectionModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-advanced-options-section-'))
  const outfile = path.join(tempDir, 'AdvancedOptionsSection.bundle.mjs')

  await build({
    entryPoints: [advancedSectionEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime'],
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function renderAdvancedOptionsSection(children?: ReactNode) {
  const { module, cleanup } = await loadAdvancedOptionsSectionModule()

  try {
    return renderToStaticMarkup(createElement(module.AdvancedOptionsSection, null, children))
  } finally {
    await cleanup()
  }
}

test('AdvancedOptionsSection is collapsed by default and keeps advanced content out of initial markup', async () => {
  const html = await renderAdvancedOptionsSection(createElement('label', null, 'Seed'))

  assert.match(html, /Advanced Options/i)
  assert.match(html, /aria-expanded="false"/i)
  assert.doesNotMatch(html, /Seed/i)
})

test('AdvancedOptionsSection renders nothing when no advanced fields are provided', async () => {
  const html = await renderAdvancedOptionsSection(null)

  assert.equal(html, '')
})
