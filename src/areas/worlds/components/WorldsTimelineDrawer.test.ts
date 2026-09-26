import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createValidWorldSnapshot } from '../core/_testFixtures.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const componentEntry = path.join(import.meta.dirname, 'WorldsTimelineDrawer.tsx')

async function loadTimelineDrawer() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-timeline-ui-test-'))
  const output = await build({
    entryPoints: [componentEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  })
  const outfile = path.join(tempDir, 'WorldsTimelineDrawer.bundle.mjs')
  await writeFile(outfile, output.outputFiles[0].text)
  return {
    source: output.outputFiles[0].text,
    module: await import(pathToFileURL(outfile).href),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  }
}

test('Timeline drawer renders compact accessible authoring and preview controls without placeholder tabs', async () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].sequences.push({
    id: 'sequence:ui', name: 'Opening', duration: { numerator: 5, denominator: 1 },
    tracks: [{ id: 'track:ui-transform', type: 'transform', entityId: 'entity:hero', keyframes: [] }],
  })
  const loaded = await loadTimelineDrawer()
  try {
    const markup = renderToStaticMarkup(createElement(loaded.module.WorldsTimelineDrawer, {
      projectKey: 'world-0123456789abcdef0123456789abcdef',
      snapshot,
      scene: snapshot.scenes[0],
      previewState: { lifecycle: 'stopped', frame: null },
      initialOpen: true,
      disabled: false,
      onCommands: () => undefined,
      onPreviewPlay: () => undefined,
      onPreviewPause: () => undefined,
      onPreviewStop: () => undefined,
      onPreviewSeek: () => undefined,
      onRefreshProject: () => undefined,
      onError: () => undefined,
    }))

    for (const accessibleName of [
      'World timeline', 'Collapse Timeline', 'Sequence', 'Create sequence', 'Delete sequence',
      'Preview sequence', 'Stop and rewind preview', 'Frames per second', 'Timeline playhead',
      'Add track', 'Move Transform up', 'Move Transform down', 'Remove Transform track',
      'Render preset', 'Render sequence',
    ]) assert.match(markup, new RegExp(`(?:aria-label|aria-labelledby)=["'][^"']*${accessibleName}`))
    assert.match(markup, />30<\/option>/)
    assert.doesNotMatch(markup, /Simulation|>AI</)
    assert.doesNotMatch(loaded.source, /useWorldsSceneStore|\.setScene\s*\(|\btitle\s*=/)
    for (const builder of [
      'buildCreateWorldSequenceCommand', 'buildRemoveWorldSequenceCommand', 'buildAddWorldSequenceTrackCommand',
      'buildRemoveWorldSequenceTrackCommand', 'buildReorderWorldSequenceTrackCommand',
      'buildAddWorldSequenceKeyframeCommand', 'buildEditWorldSequenceKeyframeCommand',
      'buildMoveWorldSequenceKeyframeCommand', 'buildRemoveWorldSequenceKeyframeCommand',
    ]) assert.match(loaded.source, new RegExp(builder))
  } finally {
    await loaded.cleanup()
  }
})

test('Timeline track drafts expose all canonical track kinds and reject incompatible targets before dispatch', async () => {
  const snapshot = createValidWorldSnapshot()
  const scene = snapshot.scenes[0]
  scene.entities[0].components.push(
    { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 },
    { id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 10, castShadow: false },
    { id: 'component:animation', type: 'animation-player', enabled: true, resourceId: 'resource:hero', autoplay: false, loop: true, speed: 1 },
    { id: 'component:audio', type: 'audio-source', enabled: true, resourceId: 'resource:hero', autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 20 },
  )
  const loaded = await loadTimelineDrawer()
  try {
    const drafts = [
      { type: 'transform', entityId: 'entity:hero' },
      { type: 'camera', entityId: 'entity:hero' },
      { type: 'light', entityId: 'entity:hero', componentId: 'component:light' },
      { type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity' },
      { type: 'animation', entityId: 'entity:hero', componentId: 'component:animation' },
      { type: 'audio', entityId: 'entity:hero', componentId: 'component:audio' },
      { type: 'event' },
    ]
    assert.deepEqual(drafts.map((draft, index) => loaded.module.createWorldTimelineTrackFromDraft(scene, draft, `track:test-${index}`)?.type), [
      'transform', 'camera', 'light', 'property', 'animation', 'audio', 'event',
    ])
    assert.equal(loaded.module.createWorldTimelineTrackFromDraft(scene, {
      type: 'light', entityId: 'entity:hero', componentId: 'component:camera',
    }, 'track:invalid'), null)
    assert.equal(loaded.module.createWorldTimelineTrackFromDraft(scene, {
      type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'resourceId',
    }, 'track:readonly'), null)
  } finally {
    await loaded.cleanup()
  }
})

test('editing one transform channel preserves every other authored channel', async () => {
  const loaded = await loadTimelineDrawer()
  try {
    const original = {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [2, 2, 2],
    }
    assert.deepEqual(
      loaded.module.mergeWorldTimelineTransformKeyframeValue(original, 'position', [4, 5, 6]),
      {
        position: [4, 5, 6],
        rotation: [0.1, 0.2, 0.3],
        scale: [2, 2, 2],
      },
    )
    assert.deepEqual(original, {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [2, 2, 2],
    })
  } finally {
    await loaded.cleanup()
  }
})

test('Timeline styling preserves 32px targets, responsive collapse, focus, and reduced motion', async () => {
  const css = await readFile(path.join(import.meta.dirname, '../WorldsWorkbench.css'), 'utf8')
  assert.match(css, /\.worlds-timeline[^}]*min-height:\s*32px/s)
  assert.match(css, /\.worlds-timeline[^}]*:focus-visible/s)
  assert.match(css, /@container\s+worlds-workbench\s*\(max-width:\s*720px\)[\s\S]*\.worlds-timeline/s)
  assert.match(css, /\.worlds-timeline__track \.inline-flex:nth-of-type\(1\)[^}]*\.inline-flex:nth-of-type\(2\)\s*\{\s*display:\s*none/)
  assert.doesNotMatch(css, /\.worlds-timeline__track \.inline-flex:nth-of-type\(3\)[^{]*\{\s*display:\s*none/)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.worlds-workbench/s)
})
