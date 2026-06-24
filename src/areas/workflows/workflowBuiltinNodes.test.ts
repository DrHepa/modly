import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const catalogEntry = path.join(projectRoot, 'src/areas/workflows/workflowBuiltinNodeCatalog.tsx')

type BuiltinCatalogModule = {
  WORKFLOW_BUILTIN_PANEL_NODES: Array<{ type: string; label: string }>
  WORKFLOW_BUILTIN_PALETTE_NODES: Array<{ type: string; label: string; color: string; description: string }>
  WORKFLOW_BUILTIN_NODE_TYPES: string[]
  createBuiltinWorkflowNode: (type: string, position: { x: number; y: number }) => { type: string; position: { x: number; y: number }; data: unknown }
}

async function loadCatalogModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-workflow-builtins-'))
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

  const module = await import(pathToFileURL(outfile).href) as BuiltinCatalogModule

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

test('workflow catalog includes both legacy preview views and single-image preview node types', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    assert.deepEqual(
      module.WORKFLOW_BUILTIN_NODE_TYPES.filter((type) => type === 'previewImageNode' || type === 'previewNode'),
      ['previewImageNode', 'previewNode'],
    )
  } finally {
    await cleanup()
  }
})

test('workflow catalog includes Load Scene as a first-class built-in source node', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    assert.ok(module.WORKFLOW_BUILTIN_NODE_TYPES.includes('sceneNode'))
    assert.deepEqual(
      module.WORKFLOW_BUILTIN_PALETTE_NODES.find((node) => node.type === 'sceneNode'),
      {
        type: 'sceneNode',
        label: 'Load Scene',
        color: '#34d399',
        description: 'Load an existing scene manifest or scene directory',
      },
    )
  } finally {
    await cleanup()
  }
})

test('workflow catalog exposes Add to Worlds as a separate output node', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    assert.ok(module.WORKFLOW_BUILTIN_NODE_TYPES.includes('addToWorldsNode'))
    assert.deepEqual(
      module.WORKFLOW_BUILTIN_PALETTE_NODES.find((node) => node.type === 'addToWorldsNode'),
      {
        type: 'addToWorldsNode',
        label: 'Add to Worlds',
        color: '#a78bfa',
        description: 'Output node — adds the mesh to Worlds',
      },
    )
  } finally {
    await cleanup()
  }
})

test('createBuiltinWorkflowNode initializes preview nodes with workflow-safe defaults', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const node = module.createBuiltinWorkflowNode('previewImageNode', { x: 24, y: 48 })

    assert.equal(node.type, 'previewImageNode')
    assert.deepEqual(node.position, { x: 24, y: 48 })
    assert.deepEqual(node.data, { extensionId: undefined, enabled: true, params: {} })
  } finally {
    await cleanup()
  }
})

test('workflow built-in drag panel exposes both preview nodes with distinct labels', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const previewEntries = module.WORKFLOW_BUILTIN_PANEL_NODES.filter((node) => node.type === 'previewImageNode' || node.type === 'previewNode')

    assert.deepEqual(
      previewEntries.map((node) => [node.type, node.label]),
      [
        ['previewImageNode', 'Preview Image'],
        ['previewNode', 'Preview Views'],
      ],
    )
  } finally {
    await cleanup()
  }
})

test('workflow palette copy clarifies single-image versus multi-view previews', async () => {
  const { module, cleanup } = await loadCatalogModule()

  try {
    const previewPaletteEntries = module.WORKFLOW_BUILTIN_PALETTE_NODES.filter((node) => node.type === 'previewImageNode' || node.type === 'previewNode')

    assert.deepEqual(
      previewPaletteEntries.map((node) => [node.label, node.description]),
      [
        ['Preview Image', 'Displays a single upstream image output'],
        ['Preview Views', 'Displays multi-view image strips in a 2×3 grid'],
      ],
    )
  } finally {
    await cleanup()
  }
})
