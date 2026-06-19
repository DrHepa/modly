import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

import { build } from 'esbuild'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const selectorEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldAssetSelector.tsx')

async function loadSelectorModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-world-selector-test-'))
  const outfile = path.join(tempDir, 'WorldAssetSelector.bundle.mjs')
  const result = await build({
    entryPoints: [selectorEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [{ name: 'canonical-react', setup(api) {
      api.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
    } }],
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

test('selection list items contain native toggle buttons with independent pressed state and actions', async () => {
  const { module, cleanup } = await loadSelectorModule()
  const choices: string[] = []
  const assets = [openableAsset('first', 'First', 'PLY mesh'), openableAsset('second', 'Second', 'PLY points')]
  try {
    for (const selectedAssetId of ['first', 'second']) {
      const tree = module.WorldAssetSelector({ open: true, assets, selectedAssetId, loading: false, opening: false, error: null,
        onToggle: () => {}, onClose: () => {}, onRefresh: () => {}, onSelectAsset: (id: string) => choices.push(id), onOpenSelected: () => {},
      })
      const actions: Array<{ element: ReactElement<any>; parent: ReactElement<any> | undefined }> = []
      function walk(node: ReactNode, parent?: ReactElement<any>): void {
        if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string }>(node)) return
        if (node.props['aria-label']?.startsWith('Select world asset ')) actions.push({ element: node, parent })
        Children.forEach(node.props.children, child => walk(child, node))
      }
      walk(tree)
      assert.equal(actions.length, 2)
      actions.forEach(({ element, parent }, index) => {
        assert.equal(element.type, 'button', 'native activation and focus behavior')
        assert.equal(element.props.type, 'button')
        assert.equal(element.props.role, undefined, 'do not replace button semantics with a structural role')
        assert.equal(element.props['aria-pressed'], assets[index].id === selectedAssetId)
        assert.equal(element.props['aria-label'], `Select world asset ${assets[index].name}`)
        assert.ok(parent, 'separate structural list item')
        assert.equal(parent.props.role, 'listitem')
        assert.notEqual(parent.type, 'button')
        assert.equal(parent.props['aria-pressed'], undefined)
        assert.equal(parent.props.onClick, undefined)
        assert.equal(element.props.tabIndex, undefined, 'preserve native tab order')
        assert.equal(element.props.onKeyDown, undefined, 'do not intercept native Enter/Space')
        assert.match(element.props.className, /focus-visible:ring-2/)
        element.props.onClick()
      })
    }
    assert.deepEqual(choices, ['first', 'second', 'first', 'second'])
  } finally { await cleanup() }
})
