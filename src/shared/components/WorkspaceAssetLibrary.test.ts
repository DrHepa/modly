import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const libraryEntry = path.join(projectRoot, 'src/shared/components/WorkspaceAssetLibrary.tsx')

async function loadLibraryModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-workspace-asset-library-test-'))
  const outfile = path.join(tempDir, 'WorkspaceAssetLibrary.bundle.mjs')
  const result = await build({
    entryPoints: [libraryEntry],
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

function entry(patch: Record<string, unknown> = {}) {
  return {
    id: 'hero',
    workspacePath: 'Workflows/Characters/hero.glb',
    displayName: 'Hero mesh',
    sourceScope: 'workflows',
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
    ...patch,
  }
}

test('WorkspaceAssetLibraryPopover shares search sort and capability grouping behavior', async () => {
  const { module, cleanup } = await loadLibraryModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorkspaceAssetLibraryPopover, {
      entries: [
        entry({ id: 'zulu', displayName: 'Zulu mesh', capability: 'mesh', createdAt: '2026-06-10T00:00:00.000Z' }),
        entry({ id: 'alpha', displayName: 'Alpha rig', capability: 'rigged-mesh', workspacePath: 'Workflows/Rigs/alpha.glb', createdAt: '2026-06-11T00:00:00.000Z' }),
        entry({ id: 'export', displayName: 'Export chair', sourceScope: 'exports', workspacePath: 'Exports/chair.glb', capability: 'mesh' }),
      ],
      selectedEntryId: 'alpha',
      loading: false,
      opening: false,
      error: null,
      searchQuery: 'rig',
      sortMode: 'date',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
      isEntryOpenable: (asset: { id: string }) => asset.id !== 'blocked',
      describeEntryOpenability: () => 'Ready to open in shared library.',
    }))

    assert.match(markup, /Search workspace assets/)
    assert.match(markup, /<option value="date" selected="">Date<\/option>/)
    assert.match(markup, /Workflows/)
    assert.match(markup, /Rigged mesh/)
    assert.match(markup, /Alpha rig/)
    assert.doesNotMatch(markup, /Zulu mesh/)
    assert.doesNotMatch(markup, /Export chair/)
    assert.match(markup, /Ready to open in shared library\./)
  } finally {
    await cleanup()
  }
})

test('WorkspaceAssetLibrary helpers provide default collapsed scope and capability keys', async () => {
  const { module, cleanup } = await loadLibraryModule()

  try {
    assert.deepEqual(module.getDefaultWorkspaceAssetLibraryCollapsedSectionKeys().slice(0, 3), [
      'scope:workflows',
      'capability:workflows:mesh',
      'capability:workflows:rigged-mesh',
    ])
  } finally {
    await cleanup()
  }
})
