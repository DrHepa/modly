import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
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

test('WorkspaceAssetLibraryPopover renders selectable unknown-metadata rows without enabling open', async () => {
  const { module, cleanup } = await loadLibraryModule()

  try {
    const selections: string[] = []
    const props = {
      entries: [entry({
        id: 'unknown', displayName: 'Unknown cloud', workspacePath: 'Workflows/Scans/cloud.ply',
        capability: undefined, state: 'unknown-metadata', previewKind: 'binary',
        openTarget: { kind: 'unavailable', reason: 'state-not-openable' },
      })],
      selectedEntryId: null,
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      collapsedSectionKeys: [],
      onSelectEntry: (id: string) => { selections.push(id) },
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }
    const tree = module.WorkspaceAssetLibraryPopover(props)
    const markup = renderToStaticMarkup(tree)
    assert.match(markup, /aria-label="Capability category Unknown metadata"/)
    assert.match(markup, /aria-label="Select library asset Unknown cloud"/)
    assert.ok(module.getDefaultWorkspaceAssetLibraryCollapsedSectionKeys().includes('capability:workflows:undefined'))

    type RowProps = { children?: ReactNode, 'aria-label'?: string, 'aria-pressed'?: boolean, disabled?: boolean, onClick?: () => void }
    function findRow(node: ReactNode): ReactElement<RowProps> | undefined {
      let row: ReactElement<RowProps> | undefined
      Children.forEach(node, child => {
        if (!isValidElement<RowProps>(child)) return
        if (child.type === 'button' && child.props['aria-label'] === 'Select library asset Unknown cloud') row = child
        else row ??= findRow(child.props.children)
      })
      return row
    }
    const row = findRow(tree)
    assert.ok(row)
    assert.notEqual(row.props.disabled, true)
    const select = row.props.onClick
    assert.ok(select)
    select()
    assert.deepEqual(selections, ['unknown'])

    const selectedTree = module.WorkspaceAssetLibraryPopover({ ...props, selectedEntryId: selections[0] })
    assert.equal(findRow(selectedTree)?.props['aria-pressed'], true)
    const selectedMarkup = renderToStaticMarkup(selectedTree)
    assert.match(selectedMarkup, /Missing metadata prevents a safe open/)
    assert.match(selectedMarkup, /<button[^>]*disabled=""[^>]*aria-label="Open selected asset"/)
  } finally {
    await cleanup()
  }
})

test('WorkspaceAssetLibraryPopover finds entries by warning-only query tokens', async () => {
  const { module, cleanup } = await loadLibraryModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorkspaceAssetLibraryPopover, {
      entries: [
        entry({
          id: 'warning-only', displayName: 'Inspected asset', workspacePath: 'Workflows/Scenes/huge.json',
          capability: 'scene-manifest', previewKind: 'text',
          warnings: ['Skipped optional manifest inspection for Workflows/Scenes/huge.json: Library metadata exceeds inspection limit'],
          openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' },
        }),
        entry({ id: 'ordinary', displayName: 'Ordinary mesh', workspacePath: 'Workflows/Props/ordinary.glb' }),
      ],
      selectedEntryId: null,
      loading: false,
      opening: false,
      error: null,
      searchQuery: 'inspection limit',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))
    assert.match(markup, /aria-label="Capability category Scene manifests"/)
    assert.match(markup, /aria-label="Select library asset Inspected asset"/)
    assert.doesNotMatch(markup, /aria-label="Select library asset Ordinary mesh"/)
    assert.doesNotMatch(markup, /No workspace assets match/)
  } finally {
    await cleanup()
  }
})
