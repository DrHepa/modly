import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const generatePageEntry = path.join(projectRoot, 'src/areas/generate/GeneratePage.tsx')

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

async function loadGeneratePageModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-generate-page-'))
  const outfile = path.join(tempDir, 'GeneratePage.bundle.mjs')

  await build({
    entryPoints: [generatePageEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [aliasPlugin()],
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

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
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
    assert.doesNotMatch(markup, /Workflows\/Characters\/hero\.glb/)
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
