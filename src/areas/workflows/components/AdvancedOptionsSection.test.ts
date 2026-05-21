import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const advancedSectionEntry = path.join(projectRoot, 'src/areas/workflows/components/AdvancedOptionsSection.tsx')

async function loadAdvancedOptionsSectionModule() {
  const result = await build({
    entryPoints: [advancedSectionEntry], write: false, bundle: true, format: 'cjs', platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/*', 'react-dom/server', '@xyflow/react', 'zustand', 'axios'],
    loader: { '.webp': 'dataurl' },
  })
  const module = { exports: {} as any }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: createRequire(import.meta.url), console, process, Promise,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  return { module: module.exports, async cleanup() {} }
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
