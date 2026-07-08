import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const nodeTypesEntry = path.join(projectRoot, 'src/areas/workflows/workflowNodeTypes.tsx')
const landmarksNodeEntry = path.join(projectRoot, 'src/areas/workflows/nodes/LandmarksNode.tsx')
const landmarksNodeGuideEntry = path.join(projectRoot, 'src/areas/workflows/nodes/LandmarksNodeGuide.tsx')

async function bundleModule(entry: string, bundleName: string) {
  const tempDir = await mkdtemp(path.join(projectRoot, `.tmp-${bundleName}-`))
  const outfile = path.join(tempDir, `${bundleName}.bundle.mjs`)

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

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

test('workflow nodeTypes maps landmarksNode to the LandmarksNode component', async () => {
  const { module, cleanup } = await bundleModule(nodeTypesEntry, 'workflow-node-types')

  try {
    assert.equal(module.WORKFLOW_NODE_TYPES.landmarksNode?.name, 'LandmarksNode')
  } finally {
    await cleanup()
  }
})

test('workflow nodeTypes maps sceneNode to the LoadSceneNode component', async () => {
  const { module, cleanup } = await bundleModule(nodeTypesEntry, 'workflow-node-types-scene')

  try {
    assert.equal(module.WORKFLOW_NODE_TYPES.sceneNode?.name, 'LoadSceneNode')
  } finally {
    await cleanup()
  }
})

test('LandmarksNode renders basic beginner-friendly guidance copy', async () => {
  const { module, cleanup } = await bundleModule(landmarksNodeEntry, 'landmarks-node')

  try {
    const markup = renderToStaticMarkup(
      React.createElement(module.LandmarksNodeContent, { completedCount: 0, totalCount: 5 }),
    )

    assert.match(markup, /Landmarks/i)
    assert.match(markup, /pick the 5 required landmarks/i)
    assert.match(markup, /0 of 5/i)
  } finally {
    await cleanup()
  }
})

test('LandmarksNode copy reflects completed landmark progress', async () => {
  const { module, cleanup } = await bundleModule(landmarksNodeEntry, 'landmarks-node-progress')

  try {
    const markup = renderToStaticMarkup(
      React.createElement(module.LandmarksNodeContent, { completedCount: 3, totalCount: 5 }),
    )

    assert.match(markup, /3 of 5/i)
    assert.doesNotMatch(markup, /0 of 5/i)
  } finally {
    await cleanup()
  }
})

test('resolveLandmarksNodeProgress reads live completed count for the active node session', async () => {
  const { module, cleanup } = await bundleModule(landmarksNodeEntry, 'landmarks-node-live-progress')

  try {
    assert.deepEqual(
      module.resolveLandmarksNodeProgress({
        nodeId: 'landmarks-node',
        session: {
          nodeId: 'landmarks-node',
          completed: {
            left_shoulder: { id: 'left_shoulder' },
            right_shoulder: { id: 'right_shoulder' },
            hip: { id: 'hip' },
            left_knee: { id: 'left_knee' },
            right_knee: { id: 'right_knee' },
          },
        },
      }),
      { completedCount: 5, totalCount: 5 },
    )
  } finally {
    await cleanup()
  }
})

test('resolveLandmarksNodeProgress returns 0 of 5 after reset clears completed landmarks', async () => {
  const { module, cleanup } = await bundleModule(landmarksNodeEntry, 'landmarks-node-reset-progress')

  try {
    assert.deepEqual(
      module.resolveLandmarksNodeProgress({
        nodeId: 'landmarks-node',
        session: {
          nodeId: 'landmarks-node',
          completed: {},
        },
      }),
      { completedCount: 0, totalCount: 5 },
    )
    assert.deepEqual(
      module.resolveLandmarksNodeProgress({
        nodeId: 'other-landmarks-node',
        session: {
          nodeId: 'landmarks-node',
          completed: {
            left_shoulder: { id: 'left_shoulder' },
          },
        },
      }),
      { completedCount: 0, totalCount: 5 },
    )
  } finally {
    await cleanup()
  }
})

test('LandmarksNodeGuide renders empty state badges, legend labels, and a packaged decorative character', async () => {
  const { module, cleanup } = await bundleModule(landmarksNodeGuideEntry, 'landmarks-node-guide-empty')

  try {
    const guide = {
      items: [
        { id: 'right_shoulder', token: 'RS', label: 'Right shoulder', color: '#38bdf8', guidePosition: { x: 34, y: 21 }, visual: { anchor: { x: 34, y: 21 }, badge: { x: 19, y: 19 } }, completed: false },
        { id: 'left_shoulder', token: 'LS', label: 'Left shoulder', color: '#fbbf24', guidePosition: { x: 59, y: 21 }, visual: { anchor: { x: 59, y: 21 }, badge: { x: 74, y: 19 } }, completed: false },
        { id: 'hip', token: 'H', label: 'Hip', color: '#f97316', guidePosition: { x: 46, y: 41 }, visual: { anchor: { x: 46, y: 41 }, badge: { x: 68, y: 41 } }, completed: false },
        { id: 'left_knee', token: 'LK', label: 'Left knee', color: '#a78bfa', guidePosition: { x: 55, y: 64 }, visual: { anchor: { x: 55, y: 64 }, badge: { x: 73, y: 66 } }, completed: false },
        { id: 'right_knee', token: 'RK', label: 'Right knee', color: '#22c55e', guidePosition: { x: 38, y: 64 }, visual: { anchor: { x: 38, y: 64 }, badge: { x: 20, y: 66 } }, completed: false },
      ],
      completedCount: 0,
      totalCount: 5,
      progressLabel: '0 of 5',
      status: 'empty',
      instruction: 'Start by marking points in the 3D viewer.',
    }
    const markup = renderToStaticMarkup(React.createElement(module.LandmarksNodeGuide, { guide }))

    assert.match(markup, /0 of 5/i)
    assert.match(markup, /Start by marking points in the 3D viewer\./i)
    assert.match(markup, /Right shoulder/i)
    assert.match(markup, /Left shoulder/i)
    assert.match(markup, /Hip/i)
    assert.match(markup, /Left knee/i)
    assert.match(markup, /Right knee/i)
    assert.match(markup, /aria-label="RS Right shoulder pending"/i)
    assert.match(markup, /aria-hidden="true" style="left:40.9%;top:21%;background-color:#38bdf8"/i)
    assert.match(markup, /aria-hidden="true" style="left:55.1%;top:21%;background-color:#fbbf24"/i)
    assert.match(markup, /style="left:32.3%;top:19%;background-color:rgba\(24,24,27,0.88\)"/i)
    assert.match(markup, /aria-hidden="true" style="left:47.7%;top:41%;background-color:#f97316"/i)
    assert.match(markup, /style="left:60.3%;top:41%;background-color:rgba\(24,24,27,0.88\)"/i)
    assert.match(markup, /aria-hidden="true" style="left:43.1%;top:64%;background-color:#22c55e"/i)
    assert.match(markup, /aria-hidden="true" style="left:52.9%;top:64%;background-color:#a78bfa"/i)
    assert.match(markup, /absolute h-px origin-left bg-zinc-200\/35/i)
    assert.match(markup, /alt=""/i)
    assert.match(markup, /aria-hidden="true"/i)
    assert.match(markup, /data:image\/webp/i)
    assert.match(markup, /Clean character reference/i)
    assert.doesNotMatch(markup, /\/home\/drhepa/i)
    assert.doesNotMatch(markup, /mix-blend-screen/i)
  } finally {
    await cleanup()
  }
})

test('LandmarksNodeGuide renders partial and complete states with real progress and CTA state', async () => {
  const { module, cleanup } = await bundleModule(landmarksNodeGuideEntry, 'landmarks-node-guide-progress')

  try {
    const baseItems = [
      { id: 'right_shoulder', token: 'RS', label: 'Right shoulder', color: '#38bdf8', guidePosition: { x: 34, y: 21 }, visual: { anchor: { x: 34, y: 21 }, badge: { x: 19, y: 19 } }, completed: true },
      { id: 'left_shoulder', token: 'LS', label: 'Left shoulder', color: '#fbbf24', guidePosition: { x: 59, y: 21 }, visual: { anchor: { x: 59, y: 21 }, badge: { x: 74, y: 19 } }, completed: false },
      { id: 'hip', token: 'H', label: 'Hip', color: '#f97316', guidePosition: { x: 46, y: 41 }, visual: { anchor: { x: 46, y: 41 }, badge: { x: 68, y: 41 } }, completed: true },
      { id: 'left_knee', token: 'LK', label: 'Left knee', color: '#a78bfa', guidePosition: { x: 55, y: 64 }, visual: { anchor: { x: 55, y: 64 }, badge: { x: 73, y: 66 } }, completed: false },
      { id: 'right_knee', token: 'RK', label: 'Right knee', color: '#22c55e', guidePosition: { x: 38, y: 64 }, visual: { anchor: { x: 38, y: 64 }, badge: { x: 20, y: 66 } }, completed: false },
    ]
    const partialMarkup = renderToStaticMarkup(React.createElement(module.LandmarksNodeGuide, {
      guide: { items: baseItems, completedCount: 2, totalCount: 5, progressLabel: '2 of 5', status: 'partial', instruction: 'Keep placing the remaining landmarks in the 3D viewer.' },
      primaryAction: { kind: 'continue-landmarks', label: 'Finish all landmarks to continue', disabled: true },
    }))
    assert.match(partialMarkup, /2 of 5/i)
    assert.match(partialMarkup, /RS Right shoulder marked/i)
    assert.match(partialMarkup, /LS Left shoulder pending/i)
    assert.match(partialMarkup, /disabled=""/i)
    assert.match(partialMarkup, /Finish all landmarks to continue/i)

    const completeMarkup = renderToStaticMarkup(React.createElement(module.LandmarksNodeGuide, {
      guide: { items: baseItems.map((item) => ({ ...item, completed: true })), completedCount: 5, totalCount: 5, progressLabel: '5 of 5', status: 'complete', instruction: 'All points marked; continue when workflow is ready.' },
      primaryAction: { kind: 'continue-landmarks', label: 'Continue workflow', disabled: false },
    }))
    assert.match(completeMarkup, /5 of 5/i)
    assert.match(completeMarkup, /All points marked; continue when workflow is ready\./i)
    assert.match(completeMarkup, /Continue workflow/i)
    assert.doesNotMatch(completeMarkup, /disabled=""/i)
  } finally {
    await cleanup()
  }
})


test('workflow nodeTypes maps previewVideoNode to the PreviewVideoNode component', async () => {
  const { module, cleanup } = await bundleModule(nodeTypesEntry, 'workflow-node-types-preview-video')
  try {
    assert.equal(module.WORKFLOW_NODE_TYPES.previewVideoNode?.name, 'PreviewVideoNode')
  } finally {
    cleanup()
  }
})
