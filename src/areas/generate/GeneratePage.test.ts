import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const generatePageEntry = path.join(projectRoot, 'src/areas/generate/GeneratePage.tsx')
const require = createRequire(import.meta.url)

function aliasPlugin(): Plugin {
  const resolvePath = (basePath: string): string => {
    if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = `${basePath}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    if (existsSync(basePath) && statSync(basePath).isDirectory()) {
      for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = path.join(basePath, `index${extension}`)
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      }
    }
    return basePath
  }

  return {
    name: 'modly-aliases',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length))),
      }))
      buildApi.onResolve({ filter: /^@areas\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/areas', args.path.slice('@areas/'.length))),
      }))
      buildApi.onResolve({ filter: /^@\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src', args.path.slice('@/'.length))),
      }))
    },
  }
}

async function loadGeneratePageModule(mounted = false) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-generate-page-'))
  const outfile = path.join(tempDir, 'GeneratePage.bundle.mjs')

  try {
  const resolvedDependencies = new Map<string, string>()
  await build({
    ...(mounted ? { stdin: {
      contents: `export { default, AssetLibraryPopover } from ${JSON.stringify(generatePageEntry)}; export { useAppStore } from ${JSON.stringify(path.join(projectRoot, 'src/shared/stores/appStore.ts'))}; export { default as harnessReact } from 'react'; export { getHarnessBackendCallCount } from '@shared/hooks/useApi';`,
      resolveDir: projectRoot, loader: 'ts' as const,
    } } : { entryPoints: [generatePageEntry] }),
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [...(mounted ? [{ name: 'mounted-host-boundaries', setup(api: Parameters<Plugin['setup']>[0]) {
      api.onResolve({ filter: /^\.\/components\/(Viewer3D|WorkflowPanel|GenerationHUD)$/ }, args => ({ path: args.path, namespace: 'mounted-inert' }))
      api.onLoad({ filter: /.*/, namespace: 'mounted-inert' }, () => ({ contents: 'export default function InertHostBoundary() { return null }', loader: 'js' }))
      api.onResolve({ filter: /^@shared\/hooks\/useApi$/ }, () => ({ path: 'useApi', namespace: 'mounted-api' }))
      api.onLoad({ filter: /.*/, namespace: 'mounted-api' }, () => ({ contents: 'let calls = 0; export const getHarnessBackendCallCount = () => calls; export function useApi() { const unavailable = () => { calls++; throw new Error("Backend is not permitted in mounted library tests") }; return { optimizeMesh: unavailable, smoothMesh: unavailable, importMesh: unavailable } }', loader: 'js' }))
    } } satisfies Plugin] : []), aliasPlugin(), { name: 'canonical-dependencies', setup(api) {
      api.onResolve({ filter: /^[^./]|^@/ }, args => {
        if (args.path.startsWith('@shared/') || args.path.startsWith('@areas/') || args.path.startsWith('@/')) return null
        assert.notEqual(args.kind, 'require-call', 'This ESM harness must not rewrite require conditions')
        assert.notEqual(args.kind, 'require-resolve', 'This ESM harness must not rewrite require conditions')
        const url = import.meta.resolve(args.path)
        const resolved = url.startsWith('file:') ? fileURLToPath(url) : url
        resolvedDependencies.set(args.path, resolved)
        return { path: resolved, external: true }
      })
    } }],
    external: [
      'axios',
      'react',
      'react-dom',
      'react-dom/server',
      'react/jsx-runtime',
      'three',
      '@react-three/fiber',
      '@react-three/drei',
      '@react-three/postprocessing',
      '@xyflow/react',
      'zustand',
      'three-mesh-bvh',
    ],
  })

  for (const [name, suffix] of [
    ['@xyflow/react', '/dist/esm/index.mjs'],
    ['react', '/react/index.js'],
    ['react/jsx-runtime', '/react/jsx-runtime.js'],
    ['three', '/build/three.module.js'],
    ['three-mesh-bvh', '/src/index.js'],
  ]) {
    const resolved = resolvedDependencies.get(name)
    if (mounted && resolved === undefined && name !== 'react' && name !== 'react/jsx-runtime') continue
    assert.ok(resolved?.startsWith(path.join(projectRoot, 'node_modules/')), `Canonical dependency: ${name}`)
    assert.ok(resolved?.endsWith(suffix), `ESM import conditions: ${name} -> ${resolved}`)
  }

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

function libraryEntry(patch: Record<string, unknown> = {}) {
  return {
    id: 'mesh-1',
    workspacePath: 'Workflows/Characters/hero.glb',
    displayName: 'Hero mesh',
    sourceScope: 'workflows',
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
      openTarget: {
        kind: 'self',
        workspacePath: 'Workflows/Characters/hero.glb',
      },
    ...patch,
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0
}

test('GeneratePage library seam renders accessible named controls for selection and open actions', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const triggerMarkup = renderToStaticMarkup(createElement(module.AssetLibraryToggleButton, {
      open: true,
      disabled: false,
      onToggle: () => undefined,
    }))

    const popoverMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [libraryEntry()],
      selectedEntryId: 'mesh-1',
      loading: false,
      opening: false,
      error: null,
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(triggerMarkup, /aria-haspopup="dialog"/)
    assert.match(triggerMarkup, />Library</)
    assert.match(popoverMarkup, /Open selected asset/)
    assert.match(popoverMarkup, /Select library asset Hero mesh/)
    assert.doesNotMatch(popoverMarkup, /Import mesh file/)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam reports unsupported and unknown entries with open disabled', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const generatedWorldMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [libraryEntry({
        id: 'world-1',
        displayName: 'World manifest',
        capability: 'generated-world',
        openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' },
      })],
      selectedEntryId: 'world-1',
      loading: false,
      opening: false,
      error: null,
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    const unknownMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [libraryEntry({
        id: 'unknown-1',
        displayName: 'Unknown mesh',
        state: 'unknown-metadata',
        capability: undefined,
        openTarget: { kind: 'unavailable', reason: 'state-not-openable' },
      })],
      selectedEntryId: 'unknown-1',
      loading: false,
      opening: false,
      error: null,
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    const objMeshMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [libraryEntry({
        id: 'obj-1',
        workspacePath: 'Characters/hero.obj',
        displayName: 'Hero OBJ',
        capability: 'mesh',
        previewKind: 'binary',
        openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' },
      })],
      selectedEntryId: 'obj-1',
      loading: false,
      opening: false,
      error: null,
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(generatedWorldMarkup, /disabled=""/)
    assert.match(generatedWorldMarkup, /cannot open in Generate yet/i)
    assert.match(unknownMarkup, /disabled=""/)
    assert.match(unknownMarkup, /Missing metadata prevents a safe open/i)
    assert.match(objMeshMarkup, /disabled=""/)
    assert.match(objMeshMarkup, /tracked as a mesh/i)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam renders scope and capability sections with direct file entries only', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [
        libraryEntry({ id: 'mesh-1', workspacePath: 'Workflows/Characters/hero.glb', displayName: 'Hero mesh', capability: 'mesh' }),
        libraryEntry({ id: 'mesh-2', workspacePath: 'Workflows/Characters/hero-rig.glb', displayName: 'Hero rig', capability: 'rigged-mesh' }),
        libraryEntry({ id: 'mesh-3', workspacePath: 'Workflows/Motions/walk.pose-clip.v1.json', displayName: 'Walk motion', capability: 'animation-motion', previewKind: 'text', openTarget: { kind: 'linked-source', workspacePath: 'Workflows/Characters/hero.glb', relation: 'sidecar-source' } }),
        libraryEntry({ id: 'mesh-4', workspacePath: 'Workflows/Landmarks/hero.landmarks.v1.json', displayName: 'Hero landmarks', capability: 'landmarks-sidecar', previewKind: 'text', openTarget: { kind: 'linked-source', workspacePath: 'Workflows/Characters/hero.glb', relation: 'sidecar-source' } }),
        libraryEntry({ id: 'mesh-5', workspacePath: 'Workflows/Worlds/factory.world.json', displayName: 'Factory world', capability: 'generated-world', previewKind: 'text', openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' } }),
        libraryEntry({ id: 'mesh-6', workspacePath: 'Exports/Scenes/factory.scene.json', displayName: 'Factory scene', sourceScope: 'exports', capability: 'scene-manifest', previewKind: 'text', openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' } }),
        libraryEntry({ id: 'mesh-7', workspacePath: 'Exports/Props/chair.glb', displayName: 'Chair mesh', sourceScope: 'exports', capability: 'mesh', openTarget: { kind: 'self', workspacePath: 'Exports/Props/chair.glb' } }),
      ],
      selectedEntryId: 'mesh-1',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(markup, /Workflows/)
    assert.match(markup, /Exports/)
    assert.match(markup, /Mesh/)
    assert.match(markup, /Rigged mesh/)
    assert.match(markup, /Animations\/motions/)
    assert.match(markup, /Landmarks sidecars/)
    assert.match(markup, /Generated worlds/)
    assert.match(markup, /Scene manifests/)
    assert.match(markup, /Hero mesh/)
    assert.match(markup, /Hero rig/)
    assert.match(markup, /Walk motion/)
    assert.match(markup, /Hero landmarks/)
    assert.match(markup, /Factory world/)
    assert.match(markup, /Factory scene/)
    assert.match(markup, /Chair mesh/)
    assert.doesNotMatch(markup, /Workspace folder /)
    assert.doesNotMatch(markup, /Import mesh file/)
    assert.match(markup, /aria-label="Select library asset Hero mesh"/)
    assert.equal(countMatches(markup, /Ready to open this asset directly in Generate\./g), 1)
    assert.match(markup, /aria-expanded="true"/)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam starts with collapsed source scopes and collapsed capability sections by default', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const collapsedSectionKeys = module.getDefaultAssetLibraryCollapsedSectionKeys()

    const collapsedMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [
        libraryEntry({ id: 'mesh-1', workspacePath: 'Workflows/Characters/hero.glb', displayName: 'Hero mesh', capability: 'mesh' }),
        libraryEntry({ id: 'mesh-2', workspacePath: 'Exports/Props/chair.glb', displayName: 'Chair mesh', sourceScope: 'exports', capability: 'mesh', openTarget: { kind: 'self', workspacePath: 'Exports/Props/chair.glb' } }),
      ],
      selectedEntryId: 'mesh-1',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      collapsedSectionKeys,
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(collapsedMarkup, /aria-label="Toggle Workflows assets"/)
    assert.match(collapsedMarkup, /aria-label="Toggle Exports assets"/)
    assert.equal(countMatches(collapsedMarkup, /aria-expanded="false"/g), 2)
    assert.doesNotMatch(collapsedMarkup, /Hero mesh/)
    assert.doesNotMatch(collapsedMarkup, /Chair mesh/)

    const partiallyExpandedMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [libraryEntry()],
      selectedEntryId: 'mesh-1',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      collapsedSectionKeys: collapsedSectionKeys.filter((key: string) => key !== 'scope:workflows'),
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(partiallyExpandedMarkup, /aria-label="Toggle Mesh assets in Workflows"/)
    assert.match(partiallyExpandedMarkup, /aria-expanded="false"/)
    assert.doesNotMatch(partiallyExpandedMarkup, /Hero mesh/)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam keeps search results under scope and capability sections while matching run and source paths', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const entries = [
      libraryEntry({
        id: 'kimodo-motion',
        workspacePath: 'Workflows/KIMODO-20260526-072137-713D4EC6/walk.pose-clip.v1.json',
        displayName: 'Walk motion',
        capability: 'animation-motion',
        previewKind: 'text',
        source: {
          workspacePath: 'Workflows/Characters/hero.glb',
          relation: 'sidecar-source',
        },
        openTarget: {
          kind: 'linked-source',
          workspacePath: 'Workflows/Characters/hero.glb',
          relation: 'sidecar-source',
        },
      }),
      libraryEntry({ id: 'kimodo-preview', workspacePath: 'Exports/KIMODO-20260526-072137-713D4EC6/preview.glb', displayName: 'preview.glb', sourceScope: 'exports', capability: 'mesh', openTarget: { kind: 'self', workspacePath: 'Exports/KIMODO-20260526-072137-713D4EC6/preview.glb' } }),
      libraryEntry({ id: 'user-mesh', workspacePath: 'Workflows/Characters/hero.glb', displayName: 'Hero mesh', capability: 'mesh' }),
    ]

    const searchedByRunMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries,
      selectedEntryId: 'kimodo-motion',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '713D4EC6',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(searchedByRunMarkup, /Workflows/)
    assert.match(searchedByRunMarkup, /Exports/)
    assert.match(searchedByRunMarkup, /Animations\/motions/)
    assert.match(searchedByRunMarkup, /Walk motion/)
    assert.match(searchedByRunMarkup, /preview\.glb/)
    assert.doesNotMatch(searchedByRunMarkup, /Workspace folder /)

    const searchedBySourceMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [entries[0]],
      selectedEntryId: 'kimodo-motion',
      loading: false,
      opening: false,
      error: null,
      searchQuery: 'hero.glb',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(searchedBySourceMarkup, /Workflows/)
    assert.match(searchedBySourceMarkup, /Animations\/motions/)
    assert.match(searchedBySourceMarkup, /Walk motion/)
    assert.doesNotMatch(searchedBySourceMarkup, /Workspace folder /)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam exposes accessible search and empty-result status messaging', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const filteredMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [
        libraryEntry({ id: 'mesh-1', workspacePath: 'Workflows/characters/hero.glb', displayName: 'Hero mesh', capability: 'mesh' }),
        libraryEntry({ id: 'mesh-2', workspacePath: 'Exports/props/chair.glb', displayName: 'Chair mesh', capability: 'mesh' }),
        libraryEntry({ id: 'world-1', workspacePath: 'Exports/worlds/factory.world.json', displayName: 'Factory world', capability: 'generated-world', previewKind: 'text', openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' } }),
        libraryEntry({ id: 'internal-1', workspacePath: 'Workflows/.STAGE-P3-SAM/run-1/PART_MASK/mask.glb', displayName: 'Stage mask', capability: 'mesh' }),
        libraryEntry({ id: 'unsupported-1', workspacePath: 'Workflows/cache/readme.md', displayName: 'Cache notes', state: 'unsupported', capability: undefined, previewKind: 'text', openTarget: { kind: 'unavailable', reason: 'state-not-openable' } }),
      ],
      selectedEntryId: 'world-1',
      loading: false,
      opening: false,
      error: null,
      searchQuery: 'factory',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(filteredMarkup, /<label[^>]*>Search workspace assets<\/label>/)
    assert.match(filteredMarkup, /value="factory"/)
    assert.match(filteredMarkup, /Generated worlds/)
    assert.match(filteredMarkup, /Factory world/)
    assert.doesNotMatch(filteredMarkup, /Hero mesh/)
    assert.doesNotMatch(filteredMarkup, /Stage mask/)
    assert.doesNotMatch(filteredMarkup, /Cache notes/)

    const emptyMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries: [libraryEntry({ id: 'mesh-1', workspacePath: 'Workflows/characters/hero.glb', displayName: 'Hero mesh' })],
      selectedEntryId: 'mesh-1',
      loading: false,
      opening: false,
      error: null,
      searchQuery: 'no-match',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(emptyMarkup, /role="status"/)
    assert.match(emptyMarkup, /No workspace assets match “no-match”\./)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam exposes an accessible sort selector and reorders entries by name, date, and type while preserving scope hierarchy', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const entries = [
      libraryEntry({ id: 'library:Workflows/Characters/zulu.glb', workspacePath: 'Workflows/Characters/zulu.glb', displayName: 'Zulu mesh', capability: 'mesh', createdAt: '2026-06-10T00:01:00.000Z' }),
      libraryEntry({ id: 'library:Workflows/Rigs/alpha.glb', workspacePath: 'Workflows/Rigs/alpha.glb', displayName: 'Alpha rig', capability: 'rigged-mesh', createdAt: '2026-06-10T00:02:00.000Z' }),
      libraryEntry({ id: 'library:Workflows/Motions/bravo.pose-clip.v1.json', workspacePath: 'Workflows/Motions/bravo.pose-clip.v1.json', displayName: 'Bravo motion', capability: 'animation-motion', createdAt: '2026-06-10T00:03:00.000Z', previewKind: 'text', openTarget: { kind: 'linked-source', workspacePath: 'Workflows/Characters/zulu.glb', relation: 'sidecar-source' } }),
      libraryEntry({ id: 'library:Exports/Props/chair.glb', workspacePath: 'Exports/Props/chair.glb', displayName: 'Chair export', sourceScope: 'exports', capability: 'mesh', createdAt: '2026-06-10T00:04:00.000Z', openTarget: { kind: 'self', workspacePath: 'Exports/Props/chair.glb' } }),
    ]

    const typeMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries,
      selectedEntryId: 'library:Workflows/Characters/zulu.glb',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      sortMode: 'type',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    const nameMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries,
      selectedEntryId: 'library:Workflows/Characters/zulu.glb',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      sortMode: 'name',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    const dateMarkup = renderToStaticMarkup(createElement(module.AssetLibraryPopover, {
      entries,
      selectedEntryId: 'library:Workflows/Characters/zulu.glb',
      loading: false,
      opening: false,
      error: null,
      searchQuery: '',
      sortMode: 'date',
      collapsedSectionKeys: [],
      onSelectEntry: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onOpenSelected: () => undefined,
      onRefresh: () => undefined,
      onToggleSection: () => undefined,
      onClose: () => undefined,
    }))

    assert.match(typeMarkup, /<label[^>]*for="asset-library-sort"[^>]*>Sort<\/label>/)
    assert.match(typeMarkup, /<select[^>]*id="asset-library-sort"/)
    assert.match(typeMarkup, /<option value="name">Name<\/option>/)
    assert.match(typeMarkup, /<option value="date">Date<\/option>/)
    assert.match(typeMarkup, /<option value="type" selected="">Type<\/option>/)
    assert.ok(typeMarkup.indexOf('Workflows') < typeMarkup.indexOf('Exports'))
    assert.ok(typeMarkup.indexOf('Zulu mesh') < typeMarkup.indexOf('Alpha rig'))
    assert.ok(typeMarkup.indexOf('Alpha rig') < typeMarkup.indexOf('Bravo motion'))
    assert.ok(nameMarkup.indexOf('Workflows') < nameMarkup.indexOf('Exports'))
    assert.ok(nameMarkup.indexOf('Alpha rig') < nameMarkup.indexOf('Bravo motion'))
    assert.ok(nameMarkup.indexOf('Bravo motion') < nameMarkup.indexOf('Zulu mesh'))
    assert.ok(dateMarkup.indexOf('Workflows') < dateMarkup.indexOf('Exports'))
    assert.ok(dateMarkup.indexOf('Bravo motion') < dateMarkup.indexOf('Alpha rig'))
    assert.ok(dateMarkup.indexOf('Alpha rig') < dateMarkup.indexOf('Zulu mesh'))
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam keeps the library panel open for library open and import flows', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    assert.equal(module.resolveOpenPanelAfterLibrarySelection('library'), 'library')
    assert.equal(module.resolveOpenPanelAfterMeshImport('toolbar', 'import'), null)
  } finally {
    await cleanup()
  }
})

test('GeneratePage library seam adapts opened entries into currentJob-compatible viewer selections', async () => {
  const { module, cleanup } = await loadGeneratePageModule()

  try {
    const directSelection = module.resolveAssetLibraryOpenSelection(libraryEntry({
      artifactId: 'artifact-1',
      versionId: 'version-1',
    }), 'http://127.0.0.1:8000', 1700000000000)

    assert.deepEqual(directSelection, {
      historyUrl: '/workspace/Workflows/Characters/hero.glb',
      target: {
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/Characters/hero.glb',
        isCheckpointPreview: false,
        label: 'Final output',
        sourceLabel: 'Hero mesh',
        sourceKind: 'import',
        workspacePath: 'Workflows/Characters/hero.glb',
        artifactId: 'artifact-1',
        versionId: 'version-1',
      },
      job: {
        id: 'import-1700000000000',
        imageFile: '',
        status: 'done',
        progress: 100,
        outputUrl: '/workspace/Workflows/Characters/hero.glb',
        originalOutputUrl: '/workspace/Workflows/Characters/hero.glb',
        createdAt: 1700000000000,
      },
    })

    const linkedSelection = module.resolveAssetLibraryOpenSelection(libraryEntry({
      id: 'landmarks-1',
      displayName: 'Shoulder landmarks',
      capability: 'landmarks-sidecar',
      source: {
        relation: 'sidecar-source',
        workspacePath: 'Workflows/Characters/source.glb',
        assetId: 'source-asset-1',
        versionId: 'source-version-1',
      },
      openTarget: {
        kind: 'linked-source',
        workspacePath: 'Workflows/Characters/source.glb',
        relation: 'sidecar-source',
      },
    }), 'http://127.0.0.1:8000', 1700000000001)

    assert.equal(linkedSelection?.target.modelUrl, 'http://127.0.0.1:8000/workspace/Workflows/Characters/source.glb')
    assert.equal(linkedSelection?.job.outputUrl, '/workspace/Workflows/Characters/source.glb')
    assert.equal(linkedSelection?.target.artifactId, 'source-asset-1')
    assert.equal(module.resolveAssetLibraryOpenSelection(libraryEntry({
      capability: 'scene-manifest',
      openTarget: { kind: 'unavailable', reason: 'capability-not-viewable' },
    }), 'http://127.0.0.1:8000'), null)
  } finally {
    await cleanup()
  }
})

// CPU host lifecycle coverage, not browser DOM, Electron, GLB or GPU proof.
test('mounted GeneratePage fences stale lists and opens across API, selection, owner and workspace changes', async t => {
  const reconcilerPath = fileURLToPath(import.meta.resolve('react-reconciler'))
  assert.equal(reconcilerPath, path.join(projectRoot, 'node_modules/react-reconciler/index.js'))
  assert.equal(createRequire(reconcilerPath).resolve('react'), path.join(projectRoot, 'node_modules/react/index.js'))
  assert.equal(createRequire(reconcilerPath)('react'), React, 'One canonical React realm')
  type Host = { type: string; props: any; children: Host[] }
  const context = {}
  const remove = (parent: Host, child: Host) => {
    const index = parent.children.indexOf(child)
    if (index >= 0) parent.children.splice(index, 1)
  }
  const append = (parent: Host, child: Host) => { remove(parent, child); parent.children.push(child) }
  const insert = (parent: Host, child: Host, before: Host) => {
    remove(parent, child); parent.children.splice(parent.children.indexOf(before), 0, child)
  }
  const renderer = require(reconcilerPath)({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (instance: Host) => instance, prepareForCommit: () => null, resetAfterCommit: () => undefined,
    createInstance: (type: string, props: any) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
    commitUpdate: (instance: Host, _payload: unknown, _type: string, _old: unknown, props: any) => { instance.props = props },
    commitTextUpdate: (instance: Host, _old: string, text: string) => { instance.props.text = text },
    clearContainer: (host: Host) => { host.children = [] }, detachDeletedInstance: () => undefined,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  })
  const host: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (error: unknown) => { throw error }, null)
  function flush(callback: () => void = () => undefined) {
    renderer.flushSync(callback)
    for (let i = 0; i < 12; i++) {
      if (!renderer.flushPassiveEffects()) return
      renderer.flushSync(() => undefined)
    }
    assert.fail('GeneratePage effects did not settle')
  }
  async function until(condition: () => boolean, label: string) {
    for (let i = 0; i < 80 && !condition(); i++) { await Promise.resolve(); flush() }
    assert.ok(condition(), label)
    // Drain the continuation after the observable IPC/setting read, not just its producer.
    await new Promise<void>(resolve => setImmediate(resolve))
    flush()
    assert.ok(condition(), `${label} remains settled`)
  }
  function find(predicate: (node: Host) => boolean, node = host): Host | undefined {
    if (predicate(node)) return node
    for (const child of node.children) { const found = find(predicate, child); if (found) return found }
  }
  const textContent = (node: Host): string => node.type === '#text' ? node.props.text : node.children.map(textContent).join('')
  const button = (name: string) => find(node => node.type === 'button' && (node.props['aria-label'] === name || textContent(node).trim() === name))
  function click(name: string) {
    const node = button(name)
    assert.ok(node, `Rendered button: ${name}`)
    assert.equal(node.type, 'button')
    assert.ok(!node.props.disabled, `Enabled button: ${name}`)
    assert.equal(typeof node.props.onClick, 'function')
    flush(() => node.props.onClick())
  }
  const enabled = (name: string) => !!button(name) && !button(name)!.props.disabled
  const alert = () => find(node => node.props.role === 'alert')
  const selected = (name: string) => button(`Select library asset ${name}`)?.props['aria-pressed'] === true
  const pending = new Set<{ resolve: (value: any) => void }>()
  function deferred() {
    let done!: (value: any) => void
    let fail!: (reason: Error) => void
    const promise = new Promise<any>((resolve, reject) => { done = resolve; fail = reject })
    const record = {
      promise, delivered: false,
      resolve(value: any) { pending.delete(record); done(value) },
      reject(reason: Error) { pending.delete(record); fail(reason) },
    }
    pending.add(record)
    return record
  }
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const events = new EventTarget(), storage = new Map<string, string>()
  const listeners = new Map<string, Set<EventListener>>()
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
  let cleanup: (() => Promise<void>) | undefined, mounted = false
  let backendCallCount = () => 0
  let subscriptions = 0, unexpectedCalls = 0, settingsReads = 0
  const unavailable = () => { unexpectedCalls++; throw new Error('Unexpected native/backend method') }
  t.after(async () => {
    try {
      try {
        if (mounted) { flush(() => renderer.updateContainer(null, root, null, null)); mounted = false }
      } finally {
        for (const operation of pending) operation.resolve({ success: false, error: 'Harness teardown' })
        await until(() => pending.size === 0, 'Tracked requests settled during teardown')
      }
      assert.deepEqual(host.children, [])
      assert.equal(subscriptions, 0)
      assert.equal([...listeners.values()].reduce((sum, value) => sum + value.size, 0), 0)
      assert.equal(unexpectedCalls, 0)
      assert.equal(backendCallCount(), 0)
    } finally {
      try { await cleanup?.() } finally {
        storage.clear()
        for (const [name, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else Reflect.deleteProperty(globalThis, name)
        }
      }
    }
  })
  let workspaceDir = '/workspace/one'
  const firstList = deferred(), oldErrorList = deferred()
  let nextList: ReturnType<typeof deferred> | undefined = firstList
  let nextOpen = deferred()
  const listCalls: string[] = [], openCalls: unknown[] = []
  const rawEntry = (name: string) => {
    const { openTarget: _rendererOnly, ...entry } = libraryEntry({ id: `library:Workflows/${name.toLowerCase()}.glb`, artifactId: 'shared-producer-artifact', workspacePath: `Workflows/${name.toLowerCase()}.glb`, displayName: `Asset ${name}` })
    return entry
  }
  const a = { ...rawEntry('A'), capability: 'rigged-mesh', createdAt: '2026-06-10T00:01:00.000Z' }
  const b = { ...rawEntry('B'), createdAt: '2026-06-10T00:02:00.000Z' }
  const success = { success: true, entries: [a, b] }
  const electron = {
    settings: { get: async () => { settingsReads++; return { workspaceDir } } },
    scene: { onImportMesh: () => { subscriptions++ }, offImportMesh: () => { subscriptions-- } },
    workspace: { library: {
      list: () => { listCalls.push(workspaceDir); const current = nextList; nextList = undefined; return current?.promise ?? Promise.resolve(success) },
      open: async (request: unknown) => {
        openCalls.push(request)
        const operation = nextOpen
        try { return await operation.promise } finally { operation.delivered = true }
      },
      read: unavailable,
    } },
    fs: new Proxy({}, { get: () => unavailable }),
  }
  for (const [name, value] of Object.entries({
    window: {
      electron, localStorage,
      addEventListener: (type: string, listener: EventListener) => { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); events.addEventListener(type, listener) },
      removeEventListener: (type: string, listener: EventListener) => { assert.ok(listeners.get(type)?.delete(listener), 'Listener cleanup is balanced'); events.removeEventListener(type, listener) },
    },
    document: { activeElement: null }, localStorage,
  })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const loaded = await loadGeneratePageModule(true)
  cleanup = loaded.cleanup
  const { module } = loaded
  backendCallCount = module.getHarnessBackendCallCount
  assert.equal(module.harnessReact, React)
  const store = module.useAppStore
  store.setState({ currentJob: null, meshHistory: ['/existing.glb'], historyIndex: 0, apiUrl: 'http://localhost:8000' })
  const snapshot = () => ({ currentJob: store.getState().currentJob, meshHistory: store.getState().meshHistory, historyIndex: store.getState().historyIndex })
  const initial = snapshot()
  flush(() => renderer.updateContainer(createElement(module.default), root, null, null)); mounted = true
  assert.equal(subscriptions, 1)
  assert.equal(listCalls.length, 0, 'Closed library is lazy')
  click('Library')
  await until(() => listCalls.length === 1, 'First list started')
  assert.ok(!enabled('Open selected asset'))
  assert.ok(!enabled('Refresh assets'))
  flush(() => store.setState({ apiUrl: 'http://localhost:9000' }))
  await until(() => listCalls.length === 2 && enabled('Open selected asset'), 'Fresh API list completed')
  click('Toggle Workflows assets')
  click('Toggle Mesh assets in Workflows')
  click('Toggle Rigged mesh assets in Workflows')
  assert.ok(selected('Asset A'))
  function assetOrder(node = host): string[] {
    return [
      ...(node.type === 'button' && node.props['aria-label']?.startsWith('Select library asset ')
        ? [node.props['aria-label'].slice('Select library asset '.length)] : []),
      ...node.children.flatMap(child => assetOrder(child)),
    ]
  }
  const sortLabel = find(node => node.type === 'label' && node.props.htmlFor === 'asset-library-sort')
  assert.ok(sortLabel)
  assert.equal(textContent(sortLabel), 'Sort')
  const sortControl = () => {
    const control = find(node => node.type === 'select' && node.props.id === sortLabel.props.htmlFor)
    assert.ok(control, 'Sort label references a rendered native select')
    assert.equal(typeof control.props.onChange, 'function')
    return control
  }
  assert.deepEqual(sortControl().children.map(option => [option.type, option.props.value, textContent(option)]), [
    ['option', 'type', 'Type'], ['option', 'name', 'Name'], ['option', 'date', 'Date'],
  ])
  const listsBeforeSort = listCalls.length
  for (const [mode, order] of [
    ['type', ['Asset B', 'Asset A']],
    ['name', ['Asset A', 'Asset B']],
    ['date', ['Asset B', 'Asset A']],
    ['type', ['Asset B', 'Asset A']],
  ] as const) {
    flush(() => sortControl().props.onChange({ target: { value: mode } }))
    assert.equal(sortControl().props.value, mode)
    assert.deepEqual(assetOrder(), [...order], `Mounted ${mode} order`)
    assert.ok(selected('Asset A') && enabled('Open selected asset'))
    assert.deepEqual(snapshot(), initial, 'Sorting preserves job, history and history index')
    assert.equal(openCalls.length, 0, 'Sorting must not open or reselect an asset')
    assert.equal(listCalls.length, listsBeforeSort, 'Sorting must not reload the library')
  }
  let reads = settingsReads
  firstList.resolve({ success: true, entries: [{ ...a, displayName: 'Retired list' }] })
  await until(() => settingsReads > reads, 'Stale successful list reached post-read fence')
  assert.doesNotMatch(textContent(host), /Retired list/)
  assert.ok(selected('Asset A') && enabled('Open selected asset') && enabled('Refresh assets'))
  assert.equal(alert(), undefined)

  nextList = oldErrorList
  click('Refresh assets')
  await until(() => listCalls.length === 3, 'Retired error request started')
  flush(() => store.setState({ apiUrl: 'http://localhost:9100' }))
  await until(() => listCalls.length === 4 && enabled('Open selected asset'), 'New list superseded old error')
  reads = settingsReads
  oldErrorList.resolve({ success: false, error: 'Retired list error' })
  await until(() => settingsReads > reads, 'Stale error envelope reached post-read fence')
  assert.equal(alert(), undefined)
  assert.ok(selected('Asset A') && enabled('Open selected asset'))

  async function startOpen(pathname: string) {
    const count = openCalls.length
    click('Open selected asset')
    await until(() => openCalls.length === count + 1, 'Open IPC started')
    assert.deepEqual(openCalls.at(-1), { workspacePath: pathname })
    assert.ok(!enabled('Open selected asset') && !enabled('Refresh assets'))
  }
  async function completeOpen(entry: unknown) {
    const before = settingsReads
    nextOpen.resolve({ success: true, entry })
    await until(() => settingsReads > before, 'Open result reached post-read fence')
  }
  await startOpen('Workflows/a.glb')
  click('Select library asset Asset B')
  await completeOpen(a)
  assert.ok(selected('Asset B') && enabled('Open selected asset'))
  assert.deepEqual(snapshot(), initial)
  assert.equal(alert(), undefined)

  nextOpen = deferred()
  await startOpen('Workflows/b.glb')
  workspaceDir = '/workspace/two'
  await completeOpen(b)
  assert.match(textContent(alert()!), /Workspace changed/)
  assert.deepEqual(snapshot(), initial)
  assert.ok(enabled('Refresh assets'))
  click('Refresh assets')
  await until(() => listCalls.length === 5 && enabled('Open selected asset'), 'New workspace refresh recovered')
  assert.equal(listCalls.at(-1), '/workspace/two')
  assert.equal(alert(), undefined)

  nextOpen = deferred()
  await startOpen('Workflows/b.glb')
  const owner = { id: 'new-generation', status: 'generating', imageFile: '', createdAt: 1, progress: 1 }
  flush(() => store.setState({ currentJob: owner }))
  await completeOpen(b)
  assert.equal(store.getState().currentJob, owner)
  assert.deepEqual(snapshot(), { ...initial, currentJob: owner })
  assert.equal(alert(), undefined)
  assert.ok(enabled('Open selected asset'))
  flush(() => store.setState({ currentJob: null }))

  nextOpen = deferred()
  await startOpen('Workflows/b.glb')
  flush(() => store.setState({ apiUrl: 'http://localhost:9200' }))
  await until(() => listCalls.length === 6 && enabled('Open selected asset'), 'API change reloaded while old open waits')
  await completeOpen(b)
  assert.deepEqual(snapshot(), initial)
  assert.ok(selected('Asset A') && enabled('Open selected asset'))
  assert.equal(alert(), undefined)

  click('Select library asset Asset B')
  nextOpen = deferred()
  await startOpen('Workflows/b.glb')
  await completeOpen(b)
  const published = snapshot()
  assert.equal(published.currentJob.status, 'done')
  assert.equal(published.currentJob.outputUrl, '/workspace/Workflows/b.glb')
  assert.deepEqual(published.meshHistory, ['/existing.glb', '/workspace/Workflows/b.glb'])
  assert.equal(published.historyIndex, 1)
  assert.ok(selected('Asset B') && enabled('Open selected asset'))
  assert.equal(alert(), undefined)
  assert.ok(find(node => node.props.role === 'dialog' && node.props['aria-label'] === 'Workspace library'))

  for (const outcome of ['success', 'error-envelope', 'rejection'] as const) {
    await t.test(`selection A to B to A permanently retires a late ${outcome} without clearing a newer open`, async () => {
      click('Select library asset Asset A')
      nextOpen = deferred()
      await startOpen('Workflows/a.glb')
      const retired = nextOpen
      const before = snapshot(), requests = openCalls.length
      click('Select library asset Asset B')
      click('Select library asset Asset A')
      assert.ok(selected('Asset A'))
      assert.equal(openCalls.length, requests, 'Selection changes do not dispatch another open')
      const settleRetired = async (operation: ReturnType<typeof deferred>) => {
        if (outcome === 'rejection') operation.reject(new Error('Retired open rejection'))
        else operation.resolve(outcome === 'success' ? { success: true, entry: a } : { success: false, error: 'Retired open error' })
        await until(() => operation.delivered, 'Retired IPC response completed through the real service')
      }
      await settleRetired(retired)
      assert.deepEqual(snapshot(), before, 'Returning to A cannot revive the old A response')
      assert.equal(alert(), undefined, 'Retired errors cannot poison the restored selection')
      assert.ok(selected('Asset A') && enabled('Open selected asset') && enabled('Refresh assets'))

      // Retire another A request, then start a genuinely new A request before
      // the retired response arrives. Its finally must not clear the new busy state.
      nextOpen = deferred()
      await startOpen('Workflows/a.glb')
      const overlappingRetired = nextOpen
      click('Select library asset Asset B')
      assert.ok(enabled('Open selected asset'), 'A real selection transition releases opening state')
      click('Select library asset Asset A')
      nextOpen = deferred()
      await startOpen('Workflows/a.glb')
      click('Select library asset Asset A')
      assert.ok(!enabled('Open selected asset'), 'Re-selecting the same identity does not retire the current request')
      await settleRetired(overlappingRetired)
      assert.deepEqual(snapshot(), before)
      assert.equal(alert(), undefined)
      assert.ok(!enabled('Open selected asset') && !enabled('Refresh assets'), 'Old completion cannot release the new request')
      await completeOpen(a)
      assert.equal(store.getState().currentJob.status, 'done')
      assert.equal(store.getState().currentJob.outputUrl, '/workspace/Workflows/a.glb')
      assert.deepEqual(store.getState().meshHistory, [...before.meshHistory, '/workspace/Workflows/a.glb'])
      assert.equal(store.getState().historyIndex, before.historyIndex + 1)
      assert.ok(selected('Asset A') && enabled('Open selected asset'))
      assert.equal(alert(), undefined)
    })
  }

  click('Select library asset Asset B')
  const beforeUnmount = snapshot()
  nextOpen = deferred()
  await startOpen('Workflows/b.glb')
  flush(() => renderer.updateContainer(null, root, null, null)); mounted = false
  await completeOpen(b)
  assert.deepEqual(snapshot(), beforeUnmount, 'Unmounted open cannot publish')
  assert.deepEqual(host.children, [])
  assert.equal(subscriptions, 0)
  assert.equal([...listeners.values()].reduce((sum, value) => sum + value.size, 0), 0)
})
