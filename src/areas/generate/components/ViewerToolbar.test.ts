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

async function renderToolbarExport(exportName: string, props: Record<string, unknown>) {
  const { module, cleanup } = await loadViewerToolbarModule()

  try {
    return renderToStaticMarkup(createElement(module[exportName], props))
  } finally {
    await cleanup()
  }
}

const baseViewToolbarProps = {
  viewMode: 'solid',
  autoRotate: false,
  hasRig: true,
  hasAnimations: true,
  animationPlaying: false,
  onViewMode: () => undefined,
  onAutoRotate: () => undefined,
  onAnimationToggle: () => undefined,
  onScreenshot: () => undefined,
}

const actionableSceneEditControls = {
  mode: 'editing',
  selectedPartLabel: 'Door mesh',
  excludedCount: 2,
  canSave: true,
  saving: false,
  onEditCheckpoint: () => undefined,
  onHideSelected: () => undefined,
  onReset: () => undefined,
  onClear: () => undefined,
  onSave: () => undefined,
}

const editControlLabels = [
  'Edit checkpoint',
  'Hide from edited copy',
  'Reset edit plan',
  'Clear selection',
  'Save edited copy',
]

test('ViewerToolbar disables one animation control when no clips are available and preserves existing controls', async () => {
  const html = await renderToolbar({
    hasAnimations: false,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
  })

  assert.match(html, /title="No animation clips"/)
  assert.match(html, /aria-label="No animation clips"/)
  assert.match(html, /disabled=""/)
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

test('ViewerToolbar hides checkpoint edit controls when no scene edit controls are provided', async () => {
  const html = await renderToolbar({
    hasAnimations: false,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
  })

  assert.doesNotMatch(html, /title="Edit checkpoint"/)
  assert.doesNotMatch(html, /Hide from edited copy/)
  assert.doesNotMatch(html, /Exclude from export/)
  assert.doesNotMatch(html, /Save edited copy/)
})

test('ViewerToolbar renders non-destructive checkpoint edit copy and save state when eligible', async () => {
  const html = await renderToolbar({
    hasAnimations: false,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
    sceneEditControls: {
      mode: 'editing',
      selectedPartLabel: 'Door mesh',
      excludedCount: 2,
      canSave: true,
      saving: false,
      onEditCheckpoint: () => undefined,
      onHideSelected: () => undefined,
      onReset: () => undefined,
      onClear: () => undefined,
      onSave: () => undefined,
    },
  })

  assert.match(html, /title="Edit checkpoint"/)
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /title="Hide from edited copy: Door mesh"/)
  assert.match(html, /title="Reset edit plan \(2 excluded\)"/)
  assert.match(html, /title="Clear selection"/)
  assert.match(html, /title="Save edited copy"/)
  assert.doesNotMatch(html, /Delete/)
})

test('ViewerToolbar disables save and hide actions until the edit plan is actionable', async () => {
  const html = await renderToolbar({
    hasAnimations: false,
    animationPlaying: false,
    onAnimationToggle: () => undefined,
    sceneEditControls: {
      mode: 'available',
      excludedCount: 0,
      canSave: false,
      saving: false,
      onEditCheckpoint: () => undefined,
      onHideSelected: () => undefined,
      onReset: () => undefined,
      onClear: () => undefined,
      onSave: () => undefined,
    },
  })

  assert.match(html, /title="Edit checkpoint"/)
  assert.match(html, /title="Hide from edited copy"[^>]*disabled=""/)
  assert.match(html, /title="Save edited copy"[^>]*disabled=""/)
  assert.doesNotMatch(html, /Reset edit plan \(1 excluded\)/)
})

test('ViewerViewToolbar renders only view, inspection, animation, and screenshot controls on the left rail', async () => {
  const html = await renderToolbarExport('ViewerViewToolbar', baseViewToolbarProps)

  assert.match(html, /aria-label="Viewer view controls"/)
  assert.match(html, /left-4/)
  assert.match(html, /title="Solid"/)
  assert.match(html, /title="Wireframe"/)
  assert.match(html, /title="Rig bones"/)
  assert.match(html, /title="Auto-rotate"/)
  assert.match(html, /title="Play animation"/)
  assert.match(html, /title="Screenshot"/)
  for (const label of editControlLabels) {
    assert.doesNotMatch(html, new RegExp(label))
  }
})

test('ViewerEditToolbar does not render without scene edit controls and keeps view controls out of the right rail', async () => {
  const emptyHtml = await renderToolbarExport('ViewerEditToolbar', {})
  assert.equal(emptyHtml, '')

  const html = await renderToolbarExport('ViewerEditToolbar', {
    sceneEditControls: actionableSceneEditControls,
  })

  assert.match(html, /aria-label="Viewer edit controls"/)
  assert.match(html, /right-4/)
  assert.match(html, /title="Edit checkpoint"/)
  assert.match(html, /title="Hide from edited copy: Door mesh"/)
  assert.match(html, /title="Reset edit plan \(2 excluded\)"/)
  assert.match(html, /title="Clear selection"/)
  assert.match(html, /title="Save edited copy"/)
  assert.doesNotMatch(html, /title="Solid"/)
  assert.doesNotMatch(html, /title="Wireframe"/)
  assert.doesNotMatch(html, /title="Screenshot"/)
})

test('split toolbars preserve disabled pressed aria-label and title semantics', async () => {
  const viewHtml = await renderToolbarExport('ViewerViewToolbar', {
    ...baseViewToolbarProps,
    viewMode: 'wireframe',
    hasRig: false,
    hasAnimations: false,
    animationPlaying: false,
  })

  assert.match(viewHtml, /title="Wireframe"[^>]*aria-label="Wireframe"[^>]*aria-pressed="true"/)
  assert.match(viewHtml, /title="Rig bones \(rig only\)"[^>]*aria-label="Rig bones \(rig only\)"[^>]*disabled=""/)
  assert.match(viewHtml, /title="No animation clips"[^>]*aria-label="No animation clips"[^>]*disabled=""/)

  const editHtml = await renderToolbarExport('ViewerEditToolbar', {
    sceneEditControls: {
      ...actionableSceneEditControls,
      mode: 'available',
      selectedPartLabel: undefined,
      excludedCount: 0,
      canSave: false,
      saving: true,
    },
  })

  assert.match(editHtml, /title="Edit checkpoint"[^>]*aria-label="Edit checkpoint"[^>]*aria-pressed="false"/)
  assert.match(editHtml, /title="Hide from edited copy"[^>]*aria-label="Hide from edited copy"[^>]*disabled=""/)
  assert.match(editHtml, /title="Saving edited copy"[^>]*aria-label="Saving edited copy"[^>]*disabled=""/)
})

test('ViewerEditToolbar exposes only a light Advanced Options affordance without form content', async () => {
  const html = await renderToolbarExport('ViewerEditToolbar', {
    sceneEditControls: actionableSceneEditControls,
  })

  assert.match(html, /title="Advanced Options"/)
  assert.match(html, /aria-label="Advanced Options"/)
  assert.match(html, /aria-disabled="true"/)
  assert.doesNotMatch(html, /Seed/)
  assert.doesNotMatch(html, /aria-expanded=/)
})

test('ViewerEditToolbar exposes Rig Editor entry on the right rail when a rig summary exists', async () => {
  const html = await renderToolbarExport('ViewerEditToolbar', {
    rigEditorControls: {
      active: false,
      summary: {
        hasRig: true,
        stats: { boneCount: 3, skinnedMeshCount: 1 },
        warnings: [],
      },
      onOpenRigEditor: () => undefined,
    },
  })

  assert.match(html, /aria-label="Viewer edit controls"/)
  assert.match(html, /right-4/)
  assert.match(html, /title="Open Rig Editor \(3 bones\)"/)
  assert.match(html, /aria-label="Open Rig Editor \(3 bones\)"/)
  assert.match(html, /Rig Editor/)
  assert.match(html, /3 bones/)
  assert.doesNotMatch(html, /title="Solid"/)
  assert.doesNotMatch(html, /Save rig aliases/)
})

test('ViewerEditToolbar presents Rig Editor as a reversible right-rail toggle', async () => {
  const closedHtml = await renderToolbarExport('ViewerEditToolbar', {
    rigEditorControls: {
      active: false,
      summary: {
        hasRig: true,
        stats: { boneCount: 2, skinnedMeshCount: 1 },
        warnings: [],
      },
      onOpenRigEditor: () => undefined,
    },
  })
  const openHtml = await renderToolbarExport('ViewerEditToolbar', {
    rigEditorControls: {
      active: true,
      summary: {
        hasRig: true,
        stats: { boneCount: 2, skinnedMeshCount: 1 },
        warnings: [],
      },
      onOpenRigEditor: () => undefined,
    },
  })

  assert.match(closedHtml, /title="Open Rig Editor \(2 bones\)"[^>]*aria-label="Open Rig Editor \(2 bones\)"[^>]*aria-pressed="false"/)
  assert.match(openHtml, /title="Close Rig Editor \(2 bones\)"[^>]*aria-label="Close Rig Editor \(2 bones\)"[^>]*aria-pressed="true"/)
  assert.doesNotMatch(closedHtml, /Save rig aliases/)
  assert.doesNotMatch(openHtml, /Seed/)
})

test('ViewerEditToolbar renders a clear no-rig state without destructive rig actions', async () => {
  const html = await renderToolbarExport('ViewerEditToolbar', {
    rigEditorControls: {
      active: false,
      summary: {
        hasRig: false,
        stats: { boneCount: 0, skinnedMeshCount: 0 },
        warnings: ['No skeleton bones were found.'],
      },
      onOpenRigEditor: () => undefined,
    },
  })

  assert.match(html, /aria-label="Viewer edit controls"/)
  assert.match(html, /No rig detected/)
  assert.match(html, /Load a rigged character to inspect bones and aliases/)
  assert.doesNotMatch(html, /Save rig aliases/)
  assert.doesNotMatch(html, /Delete/)
  assert.doesNotMatch(html, /Export GLB/)
})

test('ViewerEditToolbar exposes Pose/Clip as a separate right-rail entry that can coexist with Rig Editor', async () => {
  const html = await renderToolbarExport('ViewerEditToolbar', {
    rigEditorControls: {
      active: false,
      summary: {
        hasRig: true,
        stats: { boneCount: 3, skinnedMeshCount: 1 },
        warnings: [],
      },
      onOpenRigEditor: () => undefined,
    },
    poseClipControls: {
      active: true,
      summary: {
        hasRig: true,
        stats: { boneCount: 3, skinnedMeshCount: 1 },
        warnings: [],
      },
      onOpenPoseClip: () => undefined,
    },
  })

  assert.match(html, /aria-label="Viewer edit controls"/)
  assert.match(html, /title="Open Rig Editor \(3 bones\)"/)
  assert.match(html, /title="Close Pose\/Clip \(3 bones\)"[^>]*aria-label="Close Pose\/Clip \(3 bones\)"[^>]*aria-pressed="true"/)
  assert.match(html, /Pose\/Clip/)
  assert.doesNotMatch(html, /title="Play animation"/)
  assert.doesNotMatch(html, /title="Pause animation"/)
})

test('ViewerEditToolbar keeps Pose/Clip available as a no-rig empty state without opening Rig Editor', async () => {
  const html = await renderToolbarExport('ViewerEditToolbar', {
    poseClipControls: {
      active: false,
      summary: {
        hasRig: false,
        stats: { boneCount: 0, skinnedMeshCount: 0 },
        warnings: ['No skeleton bones were found.'],
      },
      onOpenPoseClip: () => undefined,
    },
  })

  assert.match(html, /No rig for Pose\/Clip/)
  assert.match(html, /Load a rigged character to author pose clips/)
  assert.doesNotMatch(html, /Open Rig Editor/)
  assert.doesNotMatch(html, /Export GLB/)
})
