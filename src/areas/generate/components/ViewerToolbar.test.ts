import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const viewerToolbarEntry = path.join(projectRoot, 'src/areas/generate/components/ViewerToolbar.tsx')

async function loadViewerToolbarModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-viewer-toolbar-'))
  const outfile = path.join(tempDir, 'ViewerToolbar.bundle.mjs')

  await build({
    entryPoints: [viewerToolbarEntry],
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

async function renderToolbar(props: Record<string, unknown>) {
  const { module, cleanup } = await loadViewerToolbarModule()

  try {
    return renderToStaticMarkup(createElement(module.ViewerToolbar, {
      viewMode: 'solid',
      autoRotate: false,
      hasRig: false,
      onViewMode: () => undefined,
      onAutoRotate: () => undefined,
      onScreenshot: () => undefined,
      ...props,
    }))
  } finally {
    await cleanup()
  }
}

test('ViewerToolbar disables one animation control when no clips are available and preserves existing controls', async () => {
  const html = await renderToolbar({
    hasAnimations: false,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
  })

  assert.match(html, /title="No animation clips"/)
  assert.match(html, /aria-label="No animation clips"/)
  assert.match(html, /disabled=""/)
  assert.doesNotMatch(html, /aria-pressed=/)
  assert.match(html, /title="Solid"/)
  assert.match(html, /title="Wireframe"/)
  assert.match(html, /title="Rig bones \(rig only\)"/)
  assert.match(html, /title="Rig joints \(rig only\)"/)
  assert.match(html, /title="Bone influence \(rig only\)"/)
  assert.match(html, /title="Auto-rotate"/)
  assert.match(html, /title="Screenshot"/)
})

test('ViewerToolbar renders one enabled Play animation control while paused', async () => {
  const html = await renderToolbar({
    hasAnimations: true,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
  })

  const playMatches = html.match(/title="Play animation"/g) ?? []
  assert.equal(playMatches.length, 1)
  assert.match(html, /aria-label="Play animation"/)
  assert.match(html, /aria-pressed="false"/)
  assert.doesNotMatch(html, /title="No animation clips"/)
})

test('ViewerToolbar renders one pressed Pause animation control while playing', async () => {
  const html = await renderToolbar({
    hasAnimations: true,
    animationPlaying: true,
    onAnimationToggle: () => undefined,
  })

  const pauseMatches = html.match(/title="Pause animation"/g) ?? []
  assert.equal(pauseMatches.length, 1)
  assert.match(html, /aria-label="Pause animation"/)
  assert.match(html, /aria-pressed="true"/)
  assert.doesNotMatch(html, /title="Play animation"/)
})

test('ViewerToolbar enables rig inspection controls when a skeleton is available', async () => {
  const html = await renderToolbar({
    hasRig: true,
    hasAnimations: false,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
  })

  assert.match(html, /title="Rig bones"/)
  assert.match(html, /title="Rig joints"/)
  assert.match(html, /title="Bone influence"/)
  assert.doesNotMatch(html, /Rig bones \(rig only\)/)
})
