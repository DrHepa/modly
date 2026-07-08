import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const catalogEntry = path.join(projectRoot, 'src/areas/workflows/workflowBuiltinNodeCatalog.tsx')

type BuiltinCatalogNode = {
  type: string
  label: string
  description?: string
}

async function loadCatalogModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-workflow-catalog-'))
  const outfile = path.join(tempDir, 'workflowBuiltinNodeCatalog.bundle.mjs')

  await build({
    entryPoints: [catalogEntry],
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

test('workflow built-in catalog exposes Landmarks as a beginner-friendly built-in node', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const panelNodes = module.WORKFLOW_BUILTIN_PANEL_NODES as BuiltinCatalogNode[]
    const paletteNodes = module.WORKFLOW_BUILTIN_PALETTE_NODES as BuiltinCatalogNode[]
    const panelEntry = panelNodes.find((node) => node.type === 'landmarksNode')
    const paletteEntry = paletteNodes.find((node) => node.type === 'landmarksNode')

    assert.deepEqual(
      [panelEntry?.label, paletteEntry?.label, module.WORKFLOW_BUILTIN_NODE_TYPES.includes('landmarksNode')],
      ['Landmarks', 'Landmarks', true],
    )
    assert.match(paletteEntry?.description ?? '', /pick the 5 required landmarks/i)
  } finally {
    await cleanup()
  }
})

test('createBuiltinWorkflowNode initializes landmarksNode with the standard enabled workflow data', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const node = module.createBuiltinWorkflowNode('landmarksNode', { x: 12, y: 34 })

    assert.equal(node.type, 'landmarksNode')
    assert.deepEqual(node.position, { x: 12, y: 34 })
    assert.deepEqual(node.data, { extensionId: undefined, enabled: true, params: {} })
  } finally {
    await cleanup()
  }
})

test('workflow built-in catalog exposes Load Scene with scene-focused copy', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const panelNodes = module.WORKFLOW_BUILTIN_PANEL_NODES as BuiltinCatalogNode[]
    const paletteNodes = module.WORKFLOW_BUILTIN_PALETTE_NODES as BuiltinCatalogNode[]
    const panelEntry = panelNodes.find((node) => node.type === 'sceneNode')
    const paletteEntry = paletteNodes.find((node) => node.type === 'sceneNode')

    assert.deepEqual(
      [panelEntry?.label, paletteEntry?.label, module.WORKFLOW_BUILTIN_NODE_TYPES.includes('sceneNode')],
      ['Load Scene', 'Load Scene', true],
    )
    assert.match(paletteEntry?.description ?? '', /scene manifest|scene directory/i)
  } finally {
    await cleanup()
  }
})


test('workflow built-in catalog exposes Preview Video node', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const panelNodes = module.WORKFLOW_BUILTIN_PANEL_NODES as BuiltinCatalogNode[]
    const paletteNodes = module.WORKFLOW_BUILTIN_PALETTE_NODES as BuiltinCatalogNode[]
    const panelEntry = panelNodes.find((node) => node.type === 'previewVideoNode')
    const paletteEntry = paletteNodes.find((node) => node.type === 'previewVideoNode')

    assert.equal(panelEntry?.label, 'Preview Video')
    assert.equal(paletteEntry?.label, 'Preview Video')
    assert.equal(module.WORKFLOW_BUILTIN_NODE_TYPES.includes('previewVideoNode'), true)
  } finally {
    await cleanup()
  }
})
