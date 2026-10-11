import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

import { build } from 'esbuild'
import React, { createElement } from 'react'
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
    displayName: name,
    type,
    sourceScope,
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
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

test('WorldAssetSelector renders the shared workspace library with search sort and grouped world assets', async () => {
  const { module, cleanup } = await loadSelectorModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldAssetSelector, {
      open: true,
      assets: [
        openableAsset('fuse', 'Fuse simplified', 'PLY mesh'),
        { id: 'spz', name: 'Gaussian splat', displayName: 'Gaussian splat', type: 'Unsupported', sourceScope: 'workflows', capability: 'generated-world', state: 'ready', previewKind: 'binary', warnings: [], openable: false, workspacePath: 'Workflows/splat.spz', reason: 'unsupported-spz' },
        openableAsset('hero', 'Hero GLB', 'GLB model', 'exports'),
      ],
      selectedAssetId: 'fuse',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      sortMode: 'type',
      collapsedSectionKeys: [],
      onToggle: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      onSelectAsset: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onToggleSection: () => undefined,
      onOpenSelected: () => undefined,
    }))

    assert.match(markup, /role="dialog"/)
    assert.match(markup, /aria-label="World asset selector"/)
    assert.match(markup, /Search workspace assets/)
    assert.match(markup, /<select[^>]*id="asset-library-sort"/)
    assert.match(markup, /role="list"/)
    assert.match(markup, /Fuse simplified/)
    assert.match(markup, /mesh/)
    assert.match(markup, /Ready to open in Worlds\./)
    assert.match(markup, /Generated worlds/)
    assert.match(markup, /Gaussian splat/)
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
      assets: [{ id: 'spz', name: 'Gaussian splat', displayName: 'Gaussian splat', type: 'Unsupported', sourceScope: 'workflows', capability: 'generated-world', state: 'ready', previewKind: 'binary', warnings: [], openable: false, workspacePath: 'Workflows/splat.spz', reason: 'unsupported-spz' }],
      selectedAssetId: 'spz',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      sortMode: 'type',
      collapsedSectionKeys: [],
      onToggle: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      onSelectAsset: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onToggleSection: () => undefined,
      onOpenSelected: () => undefined,
    }))

    assert.match(markup, /w-\[320px\]/)
    assert.match(markup, /aria-haspopup="dialog"/)
    assert.match(markup, /aria-expanded="true"/)
    assert.match(markup, /disabled=""[^>]*>Open selected asset/)
    assert.match(markup, /cannot open in Worlds yet/)
    assert.doesNotMatch(markup, /<aside|Permanent|Inspector|Metadata|Provenance|Schema|Details/)
  } finally {
    await cleanup()
  }
})

type SelectorHost = { type: string; props: Record<string, unknown>; children: SelectorHost[] }
function mountSelectorHost() {
  const require = createRequire(import.meta.url)
  assert.equal(require('react'), React)
  const context = {}
  const append = (parent: SelectorHost, child: SelectorHost) => parent.children.push(child)
  const remove = (parent: SelectorHost, child: SelectorHost) => parent.children.splice(parent.children.indexOf(child), 1)
  const renderer = require('react-reconciler')({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (node: SelectorHost) => node, prepareForCommit: () => null, resetAfterCommit: () => {},
    createInstance: (type: string, props: Record<string, unknown>) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: (parent: SelectorHost, child: SelectorHost, before: SelectorHost) => parent.children.splice(parent.children.indexOf(before), 0, child),
    shouldSetTextContent: () => false, finalizeInitialChildren: () => false, prepareUpdate: () => true,
    commitUpdate: (node: SelectorHost, _payload: unknown, _type: string, _old: unknown, props: Record<string, unknown>) => { node.props = props },
    commitTextUpdate: (node: SelectorHost, _old: string, text: string) => { node.props = { text } },
    clearContainer: (node: SelectorHost) => { node.children = [] }, detachDeletedInstance: () => {},
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  })
  const host: SelectorHost = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (error: unknown) => { throw error }, null)
  const render = (element: ReturnType<typeof createElement> | null) => {
    renderer.flushSync(() => renderer.updateContainer(element, root, null))
    renderer.flushPassiveEffects()
  }
  return { host, render }
}

test('selection list items contain native toggle buttons with independent pressed state and actions', async () => {
  const { module, cleanup } = await loadSelectorModule()
  const cpu = mountSelectorHost()
  const choices: string[] = []
  const assets = [openableAsset('first', 'First', 'PLY mesh'), openableAsset('second', 'Second', 'PLY points')]
  try {
    for (const selectedAssetId of ['first', 'second']) {
      cpu.render(createElement(module.WorldAssetSelector, {
        open: true, assets, selectedAssetId, loading: false, opening: false, error: null,
        searchQuery: '', sortMode: 'type', collapsedSectionKeys: [],
        onToggle: () => {}, onClose: () => {}, onRefresh: () => {}, onSelectAsset: (id: string) => choices.push(id), onOpenSelected: () => {},
        onSearchQueryChange: () => {}, onSortModeChange: () => {}, onToggleSection: () => {},
      }))
      const actions: Array<{ element: SelectorHost; parent: SelectorHost | undefined }> = []
      function walk(node: SelectorHost, parent?: SelectorHost): void {
        const label = node.props['aria-label']
        if (typeof label === 'string' && label.startsWith('Select library asset ')) actions.push({ element: node, parent })
        node.children.forEach(child => walk(child, node))
      }
      walk(cpu.host)
      assert.equal(actions.length, 2)
      actions.forEach(({ element, parent }, index) => {
        assert.equal(element.type, 'button', 'native activation and focus behavior')
        assert.equal(element.props.type, 'button')
        assert.equal(element.props.role, undefined, 'do not replace button semantics with a structural role')
        assert.equal(element.props['aria-pressed'], assets[index].id === selectedAssetId)
        assert.equal(element.props['aria-label'], `Select library asset ${assets[index].name}`)
        assert.ok(parent, 'separate structural list item')
        assert.equal(parent.props.role, 'listitem')
        assert.notEqual(parent.type, 'button')
        assert.equal(parent.props['aria-pressed'], undefined)
        assert.equal(parent.props.onClick, undefined)
        assert.equal(element.props.tabIndex, undefined, 'preserve native tab order')
        assert.equal(element.props.onKeyDown, undefined, 'do not intercept native Enter/Space')
        assert.ok(typeof element.props.className === 'string')
        assert.match(element.props.className, /focus-visible:ring-2/)
        assert.equal(parent.props.tabIndex, undefined)
        assert.equal(parent.props.onKeyDown, undefined)
        assert.equal(typeof element.props.onClick, 'function')
        if (typeof element.props.onClick !== 'function') assert.fail('Native button callback missing')
        element.props.onClick()
      })
    }
    assert.deepEqual(choices, ['first', 'second', 'first', 'second'])
  } finally { cpu.render(null); await cleanup() }
})
