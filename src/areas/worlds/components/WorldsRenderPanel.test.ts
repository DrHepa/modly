import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  WORLD_RENDER_MANIFEST_FILENAME,
  type WorldRenderJobDetail,
} from '../../../shared/types/worldRenders.ts'
import type { WorldRenderUiController, WorldRenderUiState } from '../editor/worldRenderUiController.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const componentEntry = path.join(import.meta.dirname, 'WorldsRenderPanel.tsx')
const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'

async function loadPanel() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-render-panel-test-'))
  const output = await build({
    entryPoints: [componentEntry], bundle: true, write: false, format: 'esm', platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  })
  const outfile = path.join(tempDir, 'WorldsRenderPanel.bundle.mjs')
  await writeFile(outfile, output.outputFiles[0].text)
  return { source: output.outputFiles[0].text, module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function controller(job: WorldRenderJobDetail | null, error: WorldRenderUiState['error'] = null): WorldRenderUiController {
  const state: WorldRenderUiState = { target: null, loading: false, action: 'idle', job, error }
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    open: async () => undefined,
    refresh: async () => undefined,
    start: async () => undefined,
    retry: async () => undefined,
    cancel: async () => undefined,
    delete: async () => undefined,
    dispose: () => undefined,
  }
}

function job(status: 'succeeded' | 'partial'): WorldRenderJobDetail {
  const root = `Exports/Worlds/Renders/${JOB_ID}`
  const artifact = (workspacePath: string) => ({ workspacePath, size: 1, sha256: 'a'.repeat(64) })
  return {
    jobId: JOB_ID, projectKey: PROJECT_KEY, projectId: 'project:render', revision: 4,
    sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 1920, height: 1080, fps: 30 },
    duration: { numerator: 1, denominator: 1 }, frameCount: 1, status,
    progress: { phase: 'complete', completedFrames: 1, frameCount: 1, completedUnits: 3, totalUnits: 3 },
    outputs: {
      frames: [{ ...artifact(`${root}/frames/frame-000000.png`), index: 0, time: { numerator: 0, denominator: 1 }, timestampMicroseconds: 0 }],
      audio: artifact(`${root}/audio/master.wav`), renderManifest: artifact(`${root}/${WORLD_RENDER_MANIFEST_FILENAME}`),
      webm: status === 'succeeded' ? artifact(`${root}/output.webm`) : null,
    },
    error: status === 'partial' ? { code: 'output_invalid', message: 'World render output is incomplete or invalid.', retryable: false } : null,
    createdAt: '2026-09-03T10:00:00.000Z', updatedAt: '2026-09-03T10:00:01.000Z',
  }
}

const props = {
  projectKey: PROJECT_KEY,
  revision: 4,
  sceneId: 'scene:main',
  sequenceId: 'sequence:intro',
  fps: 30 as const,
  disabled: false,
  onBeforeStart: () => undefined,
  onRefreshProject: () => undefined,
}

test('Render area is compact, accessible, 1080p-first, path-free on input, and has no editor command authority', async () => {
  const loaded = await loadPanel()
  try {
    const componentSource = await readFile(componentEntry, 'utf8')
    const markup = renderToStaticMarkup(createElement(loaded.module.WorldsRenderPanel, props))
    assert.match(markup, /aria-label="Render preset"/)
    assert.match(markup, /<option value="1080p" selected="">1080p<\/option>/)
    assert.match(markup, /aria-label="Render sequence"/)
    assert.match(markup, /aria-live="polite"/)
    assert.doesNotMatch(markup, /outputPath|absolutePath|type="text"/)
    assert.doesNotMatch(componentSource, /applyCommands|previewCommands|onCommands|worldProjectService|removeAllListeners/)
  } finally { await loaded.cleanup() }
})

test('Render area distinguishes verified WebM from partial masters and exposes only workspace-relative output', async () => {
  const loaded = await loadPanel()
  try {
    const success = renderToStaticMarkup(createElement(loaded.module.WorldsRenderPanel, { ...props, controller: controller(job('succeeded')) }))
    assert.match(success, /WebM ready/)
    assert.match(success, new RegExp(`Exports/Worlds/Renders/${JOB_ID}/output\\.webm`))
    assert.doesNotMatch(success, /Retry/)

    const partial = renderToStaticMarkup(createElement(loaded.module.WorldsRenderPanel, { ...props, controller: controller(job('partial')) }))
    assert.match(partial, /Masters kept/)
    assert.match(partial, /PNG \+ WAV kept · video failed/)
    assert.match(partial, /aria-label="Retry render"/)
    assert.doesNotMatch(partial, /WebM ready/)
  } finally { await loaded.cleanup() }
})

test('Render styling keeps 32px controls, responsive clipping, focus, progress, and reduced motion', async () => {
  const css = await readFile(path.join(import.meta.dirname, '../WorldsWorkbench.css'), 'utf8')
  assert.match(css, /\.worlds-render-panel[^}]*min-height:\s*32px/s)
  assert.match(css, /\.worlds-render-panel[^}]*:focus-visible/s)
  assert.match(css, /\.worlds-render-panel__progress/)
  assert.match(css, /@container\s+worlds-workbench\s*\(max-width:\s*720px\)[\s\S]*\.worlds-render-panel/)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.worlds-workbench/s)
})
