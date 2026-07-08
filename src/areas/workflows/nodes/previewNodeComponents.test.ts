import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

type PreviewImageResolver = (args: {
  nodeId: string
  apiUrl: string
  getEdges: () => Array<{ source: string; target: string }>
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
    getEdges: () => [{ source: 'source-a', target: 'preview-image' }],
    nodeImageOutputs: { 'source-a': '/workspace/preview.png' },
  })

  assert.equal(imageUrl, 'http://127.0.0.1:8000/workspace/preview.png')
})

test('resolvePreviewViewsNodeUrl shares the same workspace fallback behavior', async () => {
  const module = await loadPreviewNodeComponents()
  const imageUrl = module.resolvePreviewViewsNodeUrl({
    nodeId: 'preview-views',
    apiUrl: '',
    getEdges: () => [{ source: 'source-a', target: 'preview-views' }],
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
