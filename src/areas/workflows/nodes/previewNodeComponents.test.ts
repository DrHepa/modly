import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'

import PreviewImageNode, { PreviewImageContent, resolvePreviewImageNodeUrl } from './PreviewImageNode.tsx'
import PreviewViewsNode, { PreviewViewsContent, resolvePreviewViewsNodeUrl } from './PreviewViewsNode.tsx'
import ImagePreviewNode from './ImagePreviewNode.tsx'
import { WORKFLOW_NODE_TYPES } from '../workflowNodeTypes.tsx'
import { WORKFLOW_BUILTIN_NODE_TYPES } from '../workflowBuiltinNodeCatalog.tsx'
import { useAppStore } from '../../../shared/stores/appStore.ts'
import { useWorkflowRunStore } from '../workflowRunStore.ts'
import { build } from 'esbuild'

type PreviewImageResolver = (args: {
  nodeId: string
  apiUrl: string
  edges: Array<{ source: string; target: string }>
  nodeImageOutputs: Record<string, string>
}) => string | undefined

type PreviewVideoResolver = (args: {
  nodeId: string
  apiUrl: string
  getEdges: () => Array<{ source: string; target: string }>
  nodeVideoOutputs: Record<string, string>
}) => string | undefined

type PreviewNodeComponentsModule = {
  PreviewImageContent: React.ComponentType<{ imageUrl?: string }>
  resolvePreviewImageNodeUrl: PreviewImageResolver
  PreviewVideoContent: React.ComponentType<{ videoUrl?: string }>
  resolvePreviewVideoNodeUrl: PreviewVideoResolver
  PreviewViewsContent: React.ComponentType<{ imageUrl?: string }>
  resolvePreviewViewsNodeUrl: PreviewImageResolver
}

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const previewImageEntry = path.join(projectRoot, 'src/areas/workflows/nodes/PreviewImageNode.tsx')
const previewVideoEntry = path.join(projectRoot, 'src/areas/workflows/nodes/PreviewVideoNode.tsx')
const previewViewsEntry = path.join(projectRoot, 'src/areas/workflows/nodes/PreviewViewsNode.tsx')

function moduleSpecifier(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target).replace(/\\/g, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

async function bundlePreviewNodeComponents() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-preview-node-components-'))
  const entry = path.join(tempDir, 'entry.ts')
  const outfile = path.join(tempDir, 'preview-node-components.bundle.mjs')

  await writeFile(entry, `
export { PreviewImageContent, resolvePreviewImageNodeUrl } from '${moduleSpecifier(tempDir, previewImageEntry)}'
export { PreviewVideoContent, resolvePreviewVideoNodeUrl } from '${moduleSpecifier(tempDir, previewVideoEntry)}'
export { PreviewViewsContent, resolvePreviewViewsNodeUrl } from '${moduleSpecifier(tempDir, previewViewsEntry)}'
`, 'utf8')

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime', 'react-dom/server', '@xyflow/react', 'zustand', 'axios'],
    loader: { '.webp': 'dataurl' },
  })

  const module = await import(pathToFileURL(outfile).href) as PreviewNodeComponentsModule

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

let previewNodeComponents: Awaited<ReturnType<typeof bundlePreviewNodeComponents>> | undefined

async function loadPreviewNodeComponents(): Promise<PreviewNodeComponentsModule> {
  previewNodeComponents ??= await bundlePreviewNodeComponents()
  return previewNodeComponents.module
}

after(async () => {
  await previewNodeComponents?.cleanup()
})

test('resolvePreviewImageNodeUrl forwards apiUrl through the shared resolver', async () => {
  const module = await loadPreviewNodeComponents()
  const imageUrl = module.resolvePreviewImageNodeUrl({
    nodeId: 'preview-image',
    apiUrl: 'http://127.0.0.1:8000',
    edges: [{ source: 'source-a', target: 'preview-image' }],
    nodeImageOutputs: { 'source-a': '/workspace/preview.png' },
  })

  assert.equal(imageUrl, 'http://127.0.0.1:8000/workspace/preview.png')
})

test('resolvePreviewViewsNodeUrl shares the same workspace fallback behavior', async () => {
  const module = await loadPreviewNodeComponents()
  const imageUrl = module.resolvePreviewViewsNodeUrl({
    nodeId: 'preview-views',
    apiUrl: '',
    edges: [{ source: 'source-a', target: 'preview-views' }],
    nodeImageOutputs: { 'source-a': '/workspace/views.png' },
  })

  assert.equal(imageUrl, undefined)
})

test('PreviewImageContent renders a single upstream image preview', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewImageContent, { imageUrl: '/workspace/preview.png' }))

  assert.match(markup, /<img[^>]+src="\/workspace\/preview\.png"/)
  assert.match(markup, /Workflow preview output/)
})

test('PreviewImageContent lets the generated image fill the resizable node body without fixed height', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewImageContent, { imageUrl: '/workspace/preview.png' }))

  assert.match(markup, /<div class="[^"]*h-full[^"]*flex[^"]*"/)
  assert.match(markup, /<img[^>]+class="[^"]*h-full[^"]*w-full[^"]*object-contain[^"]*"/)
  assert.doesNotMatch(markup, /h-40/)
})

test('PreviewImageContent keeps empty guidance free from image layout wrappers', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewImageContent, { imageUrl: undefined }))

  assert.match(markup, /Connect an image to preview\./)
  assert.doesNotMatch(markup, /<img/)
  assert.doesNotMatch(markup, /h-full/)
})

test('PreviewImageContent renders empty guidance when no image is connected', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewImageContent, { imageUrl: undefined }))

  assert.match(markup, /Connect an image to preview\./)
})

test('PreviewViewsContent preserves the six-tile multi-view strip preview', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewViewsContent, { imageUrl: '/workspace/views.png' }))

  assert.equal((markup.match(/background-image:url\(\/workspace\/views\.png\)/g) ?? []).length, 6)
})

test('PreviewViewsContent keeps the legacy empty multi-view guidance', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewViewsContent, { imageUrl: undefined }))

  assert.match(markup, /Connect a multi-view image to preview\./)
})

test('persisted preview IDs resolve to three distinct components and every catalog entry is registered', () => {
  assert.equal(WORKFLOW_NODE_TYPES.previewNode, PreviewViewsNode)
  assert.equal(WORKFLOW_NODE_TYPES.previewImageNode, PreviewImageNode)
  assert.equal(WORKFLOW_NODE_TYPES.imagePreviewNode, ImagePreviewNode)
  for (const type of WORKFLOW_BUILTIN_NODE_TYPES) assert.equal(typeof WORKFLOW_NODE_TYPES[type], 'function')
})

test('terminal component markup exposes only the target while upstream passthrough retains both handles', () => {
  // SSR verifies the rendered handle contract, not visual layout or interaction.
  for (const [Component, sourceHandles] of [[PreviewImageNode, 0], [PreviewViewsNode, 0], [ImagePreviewNode, 1]] as const) {
    const markup = renderToStaticMarkup(React.createElement(ReactFlowProvider, { children: React.createElement(Component, { id: 'preview' }) }))
    assert.equal((markup.match(/react-flow__handle[^\"]*target/g) ?? []).length, 1)
    assert.equal((markup.match(/react-flow__handle[^\"]*source/g) ?? []).length, sourceHandles)
  }
})

for (const [Component, sinkType] of [[PreviewImageNode, 'previewImageNode'], [PreviewViewsNode, 'previewNode']] as const) {
  test(`${sinkType} actual SSR component uses current API and resolved Wait source without changing its handles`, () => {
    // Seed the real Zustand server snapshots, not a second resolver model.
    // Repeated SSR snapshots verify prop/URL composition, not live subscriptions,
    // image decoding, CSP enforcement or native Electron rendering.
    const appSnapshot = useAppStore.getInitialState()
    const runSnapshot = useWorkflowRunStore.getInitialState()
    const previousApiUrl = appSnapshot.apiUrl
    const previousImageOutputs = runSnapshot.nodeImageOutputs
    const nodes = ['imageNode', 'waitNode', 'imagePreviewNode', sinkType, 'imageNode'].map((type, i) => ({ id: String(i), type, position: { x: 0, y: 0 }, data: { enabled: true, params: {} } }))
    const edges = [{ id: 'a', source: '0', target: '1' }, { id: 'b', source: '1', target: '2' }, { id: 'c', source: '2', target: '3' }]
    const render = (apiUrl: string, currentEdges = edges, imageUrl = '/workspace/preview.png') => {
      appSnapshot.apiUrl = apiUrl
      runSnapshot.nodeImageOutputs = { '0': imageUrl, '4': '/workspace/rewired.png' }
      return renderToStaticMarkup(React.createElement(ReactFlowProvider, {
        initialNodes: nodes, initialEdges: currentEdges, children: React.createElement(Component, { id: '3' }),
      }))
    }
    try {
      for (const apiUrl of ['http://127.0.0.1:8000', 'http://127.0.0.1:9000']) {
        const markup = render(apiUrl)
        assert.ok(markup.includes(`${apiUrl}/workspace/preview.png`))
        assert.equal((markup.match(/react-flow__handle[^\"]*source/g) ?? []).length, 0)
        assert.ok(render(apiUrl, [{ id: 'rewire', source: '4', target: '3' }]).includes(`${apiUrl}/workspace/rewired.png`))
        assert.equal(render(apiUrl, []).includes('/workspace/'), false)
      }
      assert.equal(render('').includes('/workspace/'), false)
      for (const imageUrl of ['https://example.invalid/preview.png', 'data:image/png;base64,AA==']) assert.ok(render('', edges, imageUrl).includes(imageUrl))
    } finally {
      appSnapshot.apiUrl = previousApiUrl
      runSnapshot.nodeImageOutputs = previousImageOutputs
    }
  })
}
test('resolvePreviewVideoNodeUrl forwards apiUrl through the shared resolver', async () => {
  const module = await loadPreviewNodeComponents()
  const videoUrl = module.resolvePreviewVideoNodeUrl({
    nodeId: 'preview-video',
    apiUrl: 'http://127.0.0.1:8000',
    getEdges: () => [{ source: 'source-a', target: 'preview-video' }],
    nodeVideoOutputs: { 'source-a': '/workspace/video/generated.mp4' },
  })

  assert.equal(videoUrl, 'http://127.0.0.1:8000/workspace/video/generated.mp4')
})

test('PreviewVideoContent renders an HTML video player for upstream video output', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewVideoContent, { videoUrl: '/workspace/video/generated.mp4' }))

  assert.match(markup, /<video[^>]+src="\/workspace\/video\/generated\.mp4"/)
  assert.match(markup, /controls=""/)
})

test('PreviewVideoContent renders empty guidance when no video is connected', async () => {
  const module = await loadPreviewNodeComponents()
  const markup = renderToStaticMarkup(React.createElement(module.PreviewVideoContent, { videoUrl: undefined }))

  assert.match(markup, /Connect a video to preview\./)
})
