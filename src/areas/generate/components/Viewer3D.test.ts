import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import * as THREE from 'three'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const viewer3DEntry = path.join(projectRoot, 'src/areas/generate/components/Viewer3D.tsx')

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

async function loadViewer3DModule() {
  const cacheRoot = path.join(projectRoot, 'node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(cacheRoot, 'modly-viewer3d-'))
  const outfile = path.join(tempDir, 'Viewer3D.bundle.mjs')

  try {
    await build({
      entryPoints: [viewer3DEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [aliasPlugin()],
      external: [
        '@react-three/fiber',
        '@react-three/drei',
        '@xyflow/react',
        'axios',
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'three',
        'three-mesh-bvh',
        'zustand',
      ],
    })

    const module = await import(pathToFileURL(outfile).href)

    return {
      module,
      async cleanup() {
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

test('resolveViewer3DPresentation marks workflow checkpoints as temporary and not deletable', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'workflow-checkpoint',
        modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
        checkpointLabel: 'Temporary checkpoint — not final output',
        canDeleteSelectedModel: false,
        selectedHint: 'Temporary checkpoint — not final output',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DPresentation keeps final outputs deletable without checkpoint copy', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/final/model.glb',
        isCheckpointPreview: false,
        label: 'Final output',
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/final/model.glb',
        checkpointLabel: null,
        canDeleteSelectedModel: true,
        selectedHint: 'Click mesh to select • Delete to remove',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DRigSourceWorkspacePath keeps final generated workspace meshes source-backed for rig sidecars', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/unirig-character.glb?cache=manual-test',
        isCheckpointPreview: false,
        label: 'Final output',
      }),
      'Workflows/generated/unirig-character.glb',
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({
        kind: 'workflow-checkpoint',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/checkpoints/wait%20rig.glb',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      }),
      'Workflows/checkpoints/wait rig.glb',
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DRigSourceWorkspacePath refuses non-workspace, traversal, and non-mesh sources', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(module.resolveViewer3DRigSourceWorkspacePath({ kind: 'none', modelUrl: null, isCheckpointPreview: false }), undefined)
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({ kind: 'final', modelUrl: 'blob:http://local/generated', isCheckpointPreview: false, label: 'Final output' }),
      undefined,
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({ kind: 'final', modelUrl: 'http://127.0.0.1:8000/workspace/../escape.glb', isCheckpointPreview: false, label: 'Final output' }),
      undefined,
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({ kind: 'final', modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/readme.txt', isCheckpointPreview: false, label: 'Final output' }),
      undefined,
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DPresentation keeps empty viewer state non-deletable and copy-free', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'none',
        modelUrl: null,
        isCheckpointPreview: false,
      }),
      {
        modelUrl: null,
        checkpointLabel: null,
        canDeleteSelectedModel: false,
        selectedHint: 'Click mesh to select • Delete to remove',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DLandmarkMarkers derives simple markers from completed landmarks', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DLandmarkMarkers({
        right_knee: {
          id: 'right_knee',
          name: 'right_knee',
          world: { x: 6, y: 7, z: 8 },
          confidence: 1,
          source: 'manual',
        },
        left_shoulder: {
          id: 'left_shoulder',
          name: 'left_shoulder',
          world: { x: 1, y: 2, z: 3 },
          objectName: 'body-mesh',
          confidence: 1,
          source: 'manual',
        },
      }),
      [
        { id: 'left_shoulder', name: 'left_shoulder', label: 'Left shoulder', shortLabel: 'LS', color: '#fbbf24', position: { x: 1, y: 2, z: 3 }, objectName: 'body-mesh' },
        { id: 'right_knee', name: 'right_knee', label: 'Right knee', shortLabel: 'RK', color: '#22c55e', position: { x: 6, y: 7, z: 8 } },
      ],
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout offsets right-side overlays when the edit rail is visible', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: true }), {
      viewRailClassName: 'left-4 top-1/2 -translate-y-1/2 z-20',
      editRailClassName: 'right-4 top-1/2 -translate-y-1/2 z-20',
      editPanelClassName: 'right-16',
      rigEditorPanelSlot: 'top-right',
      poseClipPanelSlot: 'bottom-drawer',
      poseClipPanelClassName: 'left-4 right-16 bottom-4 max-h-[34vh]',
      commonViewportUsability: 'capped-internal-scroll',
      hintClassName: 'right-16',
      rigOverlayClassName: 'left-4 top-24 z-20',
      rigOverlaySafeArea: 'below-top-left-toolbar',
    })
    assert.deepEqual(module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: false }), {
      viewRailClassName: 'left-4 top-1/2 -translate-y-1/2 z-20',
      editRailClassName: null,
      editPanelClassName: 'right-4',
      rigEditorPanelSlot: 'top-right',
      poseClipPanelSlot: 'bottom-drawer',
      poseClipPanelClassName: 'left-4 right-16 bottom-4 max-h-[34vh]',
      commonViewportUsability: 'capped-internal-scroll',
      hintClassName: 'right-4',
      rigOverlayClassName: 'left-4 top-24 z-20',
      rigOverlaySafeArea: 'below-top-left-toolbar',
    })
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout keeps Rig Editor in the top-right slot and moves Pose/Clip to a separate lower drawer slot', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const layout = module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: true })

    assert.equal(layout.rigEditorPanelSlot, 'top-right')
    assert.equal(layout.poseClipPanelSlot, 'bottom-drawer')
    assert.notEqual(layout.poseClipPanelSlot, layout.rigEditorPanelSlot)
    assert.match(layout.poseClipPanelClassName, /bottom/)
    assert.doesNotMatch(layout.poseClipPanelClassName, /top-4/)
    assert.equal(layout.commonViewportUsability, 'capped-internal-scroll')
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout reserves the top-left toolbar area for Free memory controls', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const layout = module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: true })

    assert.equal(layout.rigOverlaySafeArea, 'below-top-left-toolbar')
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout places RigOverlay bottom-left above minimized Pose/Clip controls only while Pose/Clip is open and minimized', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const minimizedPoseClipLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: true,
      poseClipVisibility: { isOpen: true, skeletonContextId: 'rig:hero|skeleton:0', drawerMode: 'minimized' },
    })

    assert.equal(minimizedPoseClipLayout.rigOverlaySafeArea, 'above-minimized-pose-clip-controls')
    assert.match(minimizedPoseClipLayout.rigOverlayClassName, /left-4/)
    assert.match(minimizedPoseClipLayout.rigOverlayClassName, /bottom/)
    assert.doesNotMatch(minimizedPoseClipLayout.rigOverlayClassName, /top-24/)

    const expandedPoseClipLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: true,
      poseClipVisibility: { isOpen: true, skeletonContextId: 'rig:hero|skeleton:0', drawerMode: 'expanded' },
    })

    assert.equal(expandedPoseClipLayout.rigOverlaySafeArea, 'below-top-left-toolbar')
    assert.equal(expandedPoseClipLayout.rigOverlayClassName, 'left-4 top-24 z-20')
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout keeps non-open Pose/Clip contexts on the existing RigOverlay placement', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const closedPoseClipLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: false,
      poseClipVisibility: { isOpen: false, skeletonContextId: 'rig:hero|skeleton:0', drawerMode: 'minimized' },
    })

    assert.equal(closedPoseClipLayout.rigOverlaySafeArea, 'below-top-left-toolbar')
    assert.equal(closedPoseClipLayout.rigOverlayClassName, 'left-4 top-24 z-20')
  } finally {
    await cleanup()
  }
})

const rigSummary = Object.freeze({
  hasRig: true,
  sourceWorkspacePath: 'Workflows/outputs/hero.glb',
  skeletonContextId: 'rig:hero|skeleton:0',
  skinnedMeshContexts: ['rig:hero|skeleton:0'],
  rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'],
  stats: { skinnedMeshCount: 1, boneCount: 2 },
  warnings: [],
  bones: [
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      label: 'Hips',
      originalName: 'Hips',
      path: ['Hips'],
      siblingIndex: 0,
      childIds: ['rig:hero|skeleton:0|bone:hips#0/spine#0'],
      warnings: [],
    },
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      label: 'Spine',
      originalName: 'Spine',
      path: ['Hips', 'Spine'],
      siblingIndex: 0,
      parentId: 'rig:hero|skeleton:0|bone:hips#0',
      childIds: [],
      warnings: [],
    },
  ],
})

const secondRigSummary = Object.freeze({
  hasRig: true,
  sourceWorkspacePath: 'Workflows/outputs/creature.glb',
  skeletonContextId: 'rig:creature|skeleton:0',
  skinnedMeshContexts: ['rig:creature|skeleton:0'],
  rootBoneIds: ['rig:creature|skeleton:0|bone:root#0'],
  stats: { skinnedMeshCount: 1, boneCount: 1 },
  warnings: [],
  bones: [
    {
      boneId: 'rig:creature|skeleton:0|bone:root#0',
      label: 'Root',
      originalName: 'Root',
      path: ['Root'],
      siblingIndex: 0,
      childIds: [],
      warnings: [],
    },
  ],
})

const noRigSummary = Object.freeze({
  hasRig: false,
  skeletonContextId: 'rig:none|skeleton:0',
  skinnedMeshContexts: [],
  rootBoneIds: [],
  stats: { skinnedMeshCount: 0, boneCount: 0 },
  warnings: ['No skeleton bones were found.'],
  bones: [],
})

test('Viewer3D rig editor state owns selected bone and exposes controlled panel props for a rig summary', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    assert.equal(state.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {
      onSelectBone: () => {},
      onAliasChange: () => {},
      onCancelAlias: () => {},
      onRevertAliases: () => {},
      onSaveAliases: () => {},
    })

    assert.equal(panelProps.summary, rigSummary)
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(panelProps.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(panelProps.validation, { valid: true, errors: [] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig editor reducer updates alias plan without mutating the skeleton summary', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const beforeSummary = structuredClone(rigSummary)
    let state = module.createViewer3DRigEditorState(rigSummary)

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })

    assert.deepEqual(state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })
    assert.deepEqual(rigSummary, beforeSummary)

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'cancel-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    assert.deepEqual(state.renamePlan.aliases, {})

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      alias: 'Pelvis Control',
    })
    state = module.reduceViewer3DRigEditorState(state, { type: 'revert-aliases' })
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
  } finally {
    await cleanup()
  }
})

test('Viewer3D builds and writes rig rename sidecars through the dedicated workspace artifact writer', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DRigRenameSidecar({
      state,
      createdAt: '2026-05-19T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json', sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.deepEqual(requests, [
      {
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sourceWorkspacePath: 'Workflows/outputs/hero.glb',
        sidecar: {
          schema: 'modly.rig.rename-plan',
          version: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          source: { workspacePath: 'Workflows/outputs/hero.glb', artifactId: undefined, versionId: undefined },
          skeletonContextId: 'rig:hero|skeleton:0',
          skeleton: {
            rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'],
            boneCount: 2,
            bones: [
              {
                boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
                oldLabel: 'Spine',
                originalName: 'Spine',
                path: ['Hips', 'Spine'],
              },
            ],
          },
          aliases: {
            'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
          },
        },
      },
    ])
    assert.deepEqual(result, { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json', sidecar: (requests[0] as { sidecar: unknown }).sidecar })
  } finally {
    await cleanup()
  }
})

test('Viewer3D repeated rig alias saves use the same active sidecar path and persist the complete alias map', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      alias: 'Pelvis Control',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const requests: unknown[] = []
    const writer = async (request: unknown) => {
      requests.push(request)
      return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
    }

    await module.writeViewer3DRigRenameSidecar({ state, createdAt: '2026-05-19T15:43:09.000Z', writer })
    await module.writeViewer3DRigRenameSidecar({ state, createdAt: '2026-05-19T15:44:02.000Z', writer })

    assert.equal(requests.length, 2)
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json')
    assert.equal((requests[1] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json')
    assert.deepEqual((requests[1] as { sidecar: { aliases: unknown } }).sidecar.aliases, {
      'rig:hero|skeleton:0|bone:hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' },
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D builds a source-backed sidecar for a final generated rig after deriving source from its workspace URL', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const derivedSource = module.resolveViewer3DRigSourceWorkspacePath({
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/unirig-character.glb',
      isCheckpointPreview: false,
      label: 'Final output',
    })
    let state = module.createViewer3DRigEditorState({ ...rigSummary, sourceWorkspacePath: derivedSource })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DRigRenameSidecar({
      state,
      createdAt: '2026-05-19T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/unirig-character-rig-aliases.rig.v1.json', sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 1)
    assert.equal((requests[0] as { sourceWorkspacePath: string }).sourceWorkspacePath, 'Workflows/generated/unirig-character.glb')
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/rig-edits/unirig-character-rig-aliases.rig.v1.json')
    assert.deepEqual(result, { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/unirig-character-rig-aliases.rig.v1.json', sidecar: (requests[0] as { sidecar: unknown }).sidecar })
  } finally {
    await cleanup()
  }
})

test('Viewer3D refuses rig rename sidecar saves without a valid source-backed alias plan', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const noAliasState = module.createViewer3DRigEditorState(rigSummary)
    const result = await module.writeViewer3DRigRenameSidecar({
      state: noAliasState,
      createdAt: '2026-05-19T00:00:00.000Z',
      writer: async () => {
        throw new Error('writer should not be called')
      },
    })

    assert.deepEqual(result, { success: false, error: 'Rig rename sidecar requires a valid source-backed alias plan.' })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig editor state resets selection and aliases when rig context changes or no rig is present', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-summary',
      summary: secondRigSummary,
    })

    assert.equal(state.summary, secondRigSummary)
    assert.equal(state.selectedBoneId, 'rig:creature|skeleton:0|bone:root#0')
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:creature|skeleton:0', aliases: {} })

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-summary',
      summary: noRigSummary,
    })

    assert.equal(state.summary, noRigSummary)
    assert.equal(state.selectedBoneId, undefined)
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:none|skeleton:0', aliases: {} })
    assert.equal(module.resolveViewer3DRigEditorPanelProps(state, {}).summary, noRigSummary)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration derives the deterministic active sidecar path from the rig source', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(module.resolveViewer3DRigHydrationRequest(rigSummary), {
      sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
    assert.equal(module.resolveViewer3DRigHydrationRequest({ ...rigSummary, sourceWorkspacePath: undefined }), null)
    assert.equal(module.resolveViewer3DRigHydrationRequest(noRigSummary), null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration treats a missing sidecar as normal empty canonical state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigHydrationResult({
      state,
      result: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json' },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.equal(hydrated.warning, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration applies a found valid sidecar into canonical renamePlan without mutating source data', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const beforeSummary = structuredClone(rigSummary)
    const sidecar = {
      schema: 'modly.rig.rename-plan',
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      skeletonContextId: 'rig:hero|skeleton:0',
      skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
      aliases: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Legacy Spine', alias: 'Chest Control' },
      },
    }
    const beforeSidecar = structuredClone(sidecar)
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan, {
      skeletonContextId: 'rig:hero|skeleton:0',
      aliases: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
      },
    })
    assert.equal(hydrated.warning, null)
    assert.deepEqual(rigSummary, beforeSummary)
    assert.deepEqual(sidecar, beforeSidecar)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration keeps invalid sidecars non-blocking with a warning and empty plan', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const invalidRead = module.applyViewer3DRigHydrationResult({
      state,
      result: { success: false, status: 'invalid', error: 'Rig rename sidecar JSON is invalid.' },
      token,
      currentToken: token,
    })

    assert.deepEqual(invalidRead.state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(invalidRead.warning, { status: 'warning', messages: ['Rig rename sidecar JSON is invalid.'] })

    const helperInvalid = module.applyViewer3DRigHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sidecar: { schema: 'wrong', version: 1, source: { workspacePath: 'Workflows/outputs/hero.glb' }, aliases: {} },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(helperInvalid.state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(helperInvalid.warning, { status: 'warning', messages: ['Rig rename sidecar schema must be "modly.rig.rename-plan".', 'Rig rename sidecar skeletonContextId must be a string.', 'Rig rename sidecar skeleton metadata is invalid.'] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D passes rig hydration warnings through controlled Rig Editor panel props', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const hydrationWarning = { status: 'warning', messages: ['Rig rename sidecar JSON is invalid.'] }

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {}, hydrationWarning)

    assert.deepEqual(panelProps.hydrationWarning, hydrationWarning)
    assert.deepEqual(panelProps.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(panelProps.validation, { valid: true, errors: [] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration treats a missing sidecar as normal empty automatic naming state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    assert.deepEqual(module.resolveViewer3DRigMetaHydrationRequest(rigSummary), {
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: { success: true, status: 'not-found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json' },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.rigMetaNamingByBoneId, {})
    assert.equal(hydrated.warning, null)
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).rigMetaNamingByBoneId, {})
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration normalizes valid rigmeta into panel props without mutating raw rig data', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const beforeSummary = structuredClone(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json',
        warnings: [],
        namingByBoneId: {},
        rigMeta: {
          schema: 'modly.unirig.rigmeta',
          source: { workspacePath: 'Workflows/outputs/hero.glb' },
          semantic_candidates: {
            'rig:hero|skeleton:0|bone:hips#0': { resolved_label: 'UniRig Pelvis' },
          },
          humanoid_contract: {
            bones: {
              'rig:hero|skeleton:0|bone:hips#0/spine#0': 'UniRig Spine',
            },
          },
        },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.rigMetaNamingByBoneId, {
      'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
    })
    assert.equal(hydrated.warning, null)
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).effectiveNaming.ordered, [
      { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'UniRig Pelvis', rawLabel: 'Hips', provenance: 'unirig' },
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'UniRig Spine', rawLabel: 'Spine', provenance: 'unirig' },
    ])
    assert.deepEqual(rigSummary, beforeSummary)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration keeps invalid rigmeta non-blocking with empty naming and warning', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const invalidRead = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: { success: false, status: 'invalid', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', message: 'Rigmeta JSON is invalid.' },
      token,
      currentToken: token,
    })

    assert.deepEqual(invalidRead.state.rigMetaNamingByBoneId, {})
    assert.deepEqual(invalidRead.warning, { status: 'warning', messages: ['Rigmeta JSON is invalid.'] })

    const unsupported = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: { success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', rigMeta: { schema: 'wrong' }, namingByBoneId: {}, warnings: [] },
      token,
      currentToken: token,
    })

    assert.deepEqual(unsupported.state.rigMetaNamingByBoneId, {})
    assert.deepEqual(unsupported.warning, { status: 'warning', messages: ['Rigmeta schema is unsupported; known naming fields will be loaded defensively.', 'Rigmeta did not contain supported naming entries.'] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration ignores stale async results and preserves manual alias precedence', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const staleToken = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const currentToken = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'creature.glb', summary: secondRigSummary })
    const currentState = module.createViewer3DRigEditorState(secondRigSummary)

    const stale = module.applyViewer3DRigMetaHydrationResult({
      state: currentState,
      result: { success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', rigMeta: { semantic_candidates: { 'rig:hero|skeleton:0|bone:hips#0': 'UniRig Pelvis' } }, namingByBoneId: {}, warnings: [] },
      token: staleToken,
      currentToken,
    })

    assert.equal(stale.stale, true)
    assert.deepEqual(stale.state.rigMetaNamingByBoneId, {})

    let manualState = module.createViewer3DRigEditorState(rigSummary)
    manualState = module.reduceViewer3DRigEditorState(manualState, { type: 'set-alias', boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', alias: 'Manual Chest' })
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state: manualState,
      result: { success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', rigMeta: { semantic_candidates: { 'rig:hero|skeleton:0|bone:hips#0/spine#0': 'UniRig Spine' } }, namingByBoneId: {}, warnings: [] },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Manual Chest' },
    })
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).effectiveNaming.ordered, [
      { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'Hips', rawLabel: 'Hips', provenance: 'raw' },
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Manual Chest', rawLabel: 'Spine', provenance: 'manual' },
    ])
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration ignores stale async reads for old model/source/skeleton contexts', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const staleToken = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const currentToken = module.createViewer3DRigHydrationToken({ modelUrl: 'creature.glb', summary: secondRigSummary })
    const currentState = module.createViewer3DRigEditorState(secondRigSummary)

    const hydrated = module.applyViewer3DRigHydrationResult({
      state: currentState,
      result: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sidecar: {
          schema: 'modly.rig.rename-plan',
          version: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          source: { workspacePath: 'Workflows/outputs/hero.glb' },
          skeletonContextId: 'rig:hero|skeleton:0',
          skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
          aliases: { 'rig:hero|skeleton:0|bone:hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' } },
        },
      },
      token: staleToken,
      currentToken,
    })

    assert.equal(hydrated.stale, true)
    assert.deepEqual(hydrated.state.renamePlan, { skeletonContextId: 'rig:creature|skeleton:0', aliases: {} })
    assert.equal(hydrated.warning, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration does not overwrite dirty user edits when a late read resolves', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, { type: 'set-alias', boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', alias: 'Human Chest' })
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sidecar: {
          schema: 'modly.rig.rename-plan',
          version: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          source: { workspacePath: 'Workflows/outputs/hero.glb' },
          skeletonContextId: 'rig:hero|skeleton:0',
          skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
          aliases: { 'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Sidecar Chest' } },
        },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Human Chest' },
    })
    assert.equal(hydrated.dirtySkipped, true)
    assert.equal(hydrated.warning, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D keeps the Rig Editor panel hidden by default and toggles it from the right rail', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const rigState = module.createViewer3DRigEditorState(rigSummary)
    let visibility = module.createViewer3DRigEditorVisibilityState(rigSummary)

    assert.equal(visibility.isOpen, false)
    assert.equal(module.resolveViewer3DRigEditorPanelRenderState({ modelUrl: 'hero.glb', rigState, visibility }).shouldRenderPanel, false)

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, true)
    assert.equal(module.resolveViewer3DRigEditorPanelRenderState({ modelUrl: 'hero.glb', rigState, visibility }).shouldRenderPanel, true)

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, false)
    assert.equal(module.resolveViewer3DRigEditorPanelRenderState({ modelUrl: 'hero.glb', rigState, visibility }).shouldRenderPanel, false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D Rig Editor visibility preserves selection and aliases while hidden but resets for a new rig source', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    let visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, false)
    assert.equal(rigState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(rigState.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'set-summary', summary: secondRigSummary })
    rigState = module.reduceViewer3DRigEditorState(rigState, { type: 'set-summary', summary: secondRigSummary })
    assert.equal(visibility.isOpen, false)
    assert.equal(rigState.selectedBoneId, 'rig:creature|skeleton:0|bone:root#0')
    assert.deepEqual(rigState.renamePlan, { skeletonContextId: 'rig:creature|skeleton:0', aliases: {} })

    const noRigVisibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: noRigSummary })
    assert.equal(noRigVisibility.isOpen, false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D derives selected-bone overlay props from canonical rig editor state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const selected: string[] = []

    const overlayProps = module.resolveViewer3DRigOverlayProps(
      state,
      { onSelectBone: (boneId: string) => selected.push(boneId) },
      visibility,
    )

    assert.deepEqual(overlayProps.overlay, {
      selectedBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      selectedLabel: 'Spine',
      parentBoneId: 'rig:hero|skeleton:0|bone:hips#0',
      childBoneIds: [],
      highlightedBoneIds: [
        'rig:hero|skeleton:0|bone:hips#0/spine#0',
        'rig:hero|skeleton:0|bone:hips#0',
      ],
      connections: [
        { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', relation: 'parent' },
      ],
    })
    overlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(selected, ['rig:hero|skeleton:0|bone:hips#0'])
  } finally {
    await cleanup()
  }
})

test('Viewer3D selected-bone overlay displays effective labels while callbacks keep stable RigBoneId', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    state = {
      ...state,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const selected: string[] = []
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(state, {}).effectiveNaming

    const overlayProps = module.resolveViewer3DRigOverlayProps(
      state,
      { onSelectBone: (boneId: string) => selected.push(boneId) },
      visibility,
      effectiveNaming,
    )

    assert.equal(overlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(overlayProps.overlay.selectedLabel, 'Manual Chest')
    assert.notEqual(overlayProps.overlay.selectedLabel, 'UniRig Spine')
    assert.notEqual(overlayProps.overlay.selectedLabel, 'Spine')
    overlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(selected, ['rig:hero|skeleton:0|bone:hips#0'])
  } finally {
    await cleanup()
  }
})

test('Viewer3D selected-bone overlay uses UniRig effective labels before falling back to raw bone names', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = {
      ...state,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(state, {}).effectiveNaming

    const unirigOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, visibility, effectiveNaming)
    const rawOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, visibility)

    assert.equal(unirigOverlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(unirigOverlayProps.overlay.selectedLabel, 'UniRig Spine')
    assert.equal(rawOverlayProps.overlay.selectedLabel, 'Spine')
  } finally {
    await cleanup()
  }
})

test('Viewer3D hides selected-bone overlay props when the Rig Editor is closed and restores them when open', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const closedVisibility = module.createViewer3DRigEditorVisibilityState(rigSummary)

    const closedOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, closedVisibility)
    assert.equal(closedOverlayProps.overlay, null)
    assert.equal(state.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })

    const openVisibility = module.reduceViewer3DRigEditorVisibilityState(closedVisibility, { type: 'toggle', summary: rigSummary })
    const openOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, openVisibility)
    assert.deepEqual(openOverlayProps.overlay, {
      selectedBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      selectedLabel: 'Spine',
      parentBoneId: 'rig:hero|skeleton:0|bone:hips#0',
      childBoneIds: [],
      highlightedBoneIds: [
        'rig:hero|skeleton:0|bone:hips#0/spine#0',
        'rig:hero|skeleton:0|bone:hips#0',
      ],
      connections: [
        { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', relation: 'parent' },
      ],
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D omits rig overlay props when there is no valid selected rig bone', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const noRigState = module.createViewer3DRigEditorState(noRigSummary)
    const noRigOverlayProps = module.resolveViewer3DRigOverlayProps(noRigState, {})
    assert.equal(noRigOverlayProps.overlay, null)
    assert.equal(noRigOverlayProps.onSelectBone('missing-bone'), undefined)

    const staleState = {
      ...module.createViewer3DRigEditorState(rigSummary),
      selectedBoneId: 'missing-bone',
    }
    assert.equal(module.resolveViewer3DRigOverlayProps(staleState, {}).overlay, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D resolves in-view rig helper colors from selectedBoneId without new marker feedback', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const helpers = module.resolveViewer3DRigHelperStyles(rigSummary, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    assert.deepEqual(helpers.markerStylesByBoneId, {
      'rig:hero|skeleton:0|bone:hips#0': {
        tone: 'default',
        color: '#f5f3ff',
        emissive: '#7c3aed',
        emissiveIntensity: 0.55,
        scale: 1,
        renderOrder: 5,
      },
      'rig:hero|skeleton:0|bone:hips#0/spine#0': {
        tone: 'selected',
        color: '#22d3ee',
        emissive: '#67e8f9',
        emissiveIntensity: 1.35,
        scale: 1.45,
        renderOrder: 7,
      },
    })
    assert.deepEqual(helpers.segmentStylesByChildBoneId, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': {
        tone: 'selected',
        color: '#22d3ee',
        opacity: 1,
        renderOrder: 6,
      },
    })
    assert.equal(helpers.requiresNewMarker, false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D moves in-view selected helper color and falls back to default for unknown selection', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const rootSelected = module.resolveViewer3DRigHelperStyles(rigSummary, 'rig:hero|skeleton:0|bone:hips#0')
    const unknownSelected = module.resolveViewer3DRigHelperStyles(rigSummary, 'missing-bone')
    const noSelected = module.resolveViewer3DRigHelperStyles(rigSummary, undefined)

    assert.equal(rootSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0'].tone, 'selected')
    assert.equal(rootSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')
    assert.equal(rootSelected.segmentStylesByChildBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')

    assert.equal(unknownSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0'].tone, 'default')
    assert.equal(unknownSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')
    assert.equal(unknownSelected.segmentStylesByChildBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')

    assert.deepEqual(noSelected, unknownSelected)
  } finally {
    await cleanup()
  }
})

test('Viewer3D owns Pose/Clip state separately from Rig Editor and passes stable-id panel props', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    let rigVisibility = module.createViewer3DRigEditorVisibilityState(rigSummary)
    let poseVisibility = module.createViewer3DPoseClipVisibilityState(rigSummary)

    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.equal(module.resolveViewer3DPoseClipPanelRenderState({ modelUrl: 'hero.glb', poseState, visibility: poseVisibility }).shouldRenderPanel, false)

    poseVisibility = module.reduceViewer3DPoseClipVisibilityState(poseVisibility, { type: 'toggle', summary: rigSummary })
    assert.equal(poseVisibility.isOpen, true)
    assert.equal(rigVisibility.isOpen, false)
    assert.equal(module.resolveViewer3DPoseClipPanelRenderState({ modelUrl: 'hero.glb', poseState, visibility: poseVisibility }).shouldRenderPanel, true)

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const captured: string[] = []
    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {
      onCaptureKeyframe: (boneId: string) => captured.push(boneId),
    })

    assert.equal(panelProps.summary, rigSummary)
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    panelProps.onCaptureKeyframe('rig:hero|skeleton:0|bone:hips#0/spine#0', 0.25)
    assert.deepEqual(captured, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])

    rigVisibility = module.reduceViewer3DRigEditorVisibilityState(rigVisibility, { type: 'toggle', summary: rigSummary })
    assert.equal(rigVisibility.isOpen, true)
    assert.equal(poseVisibility.isOpen, true)
  } finally {
    await cleanup()
  }
})

test('Viewer3D routes Pose/Clip tree selection by stable non-root RigBoneId', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    const selected: string[] = []

    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {
      onSelectBone: (boneId: string) => selected.push(boneId),
    })

    panelProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0/spine#0')
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: selected[0],
    })

    assert.deepEqual(selected, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(poseState.plan.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.notEqual(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
  } finally {
    await cleanup()
  }
})

test('Viewer3D resolves Pose/Clip panel props with manual aliases over UniRig labels while preserving stable ids', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    rigState = {
      ...rigState,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    const panelProps = module.resolveViewer3DPoseClipPanelProps(
      poseState,
      {},
      module.resolveViewer3DRigEditorPanelProps(rigState, {}).effectiveNaming,
    )

    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(panelProps.rigDisplayNames.ordered, [
      { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'UniRig Pelvis', rawLabel: 'Hips', provenance: 'unirig' },
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Manual Chest', rawLabel: 'Spine', provenance: 'manual' },
    ])
    panelProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
  } finally {
    await cleanup()
  }
})

test('Viewer3D Pose/Clip callback regression keeps effective labels out of reducer ids and sidecar payloads', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    rigState = {
      ...rigState,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }

    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(rigState, {}).effectiveNaming
    const panelProps = module.resolveViewer3DPoseClipPanelProps(
      poseState,
      {
        onCaptureKeyframe: (boneId: string, timeSeconds: number) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'capture-keyframe',
            summary: rigSummary,
            boneId,
            timeSeconds,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          })
        },
        onCaptureAndAdvance: (boneId: string) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'capture-and-advance',
            summary: rigSummary,
            boneId,
            rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
          })
        },
        onUpdateSelectedKeyframe: (_keyframeId: string, boneId: string) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'update-selected-keyframe',
            summary: rigSummary,
            boneId,
            rotation: { x: 0.7071068, y: 0, z: 0, w: 0.7071068 },
          })
        },
        onMoveSelectedKeyframe: (_keyframeId: string, timeSeconds: number) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'move-selected-keyframe', summary: rigSummary, timeSeconds })
        },
        onDuplicateSelectedKeyframe: (_keyframeId: string) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'duplicate-selected-keyframe', summary: rigSummary })
        },
      },
      effectiveNaming,
    )

    assert.equal(panelProps.rigDisplayNames.byBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].label, 'Manual Chest')
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    panelProps.onCaptureKeyframe(panelProps.selectedBoneId, 0.25)
    panelProps.onCaptureAndAdvance(panelProps.selectedBoneId)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: poseState.plan.keyframes[0].id })
    const selectedKeyframeId = poseState.selectedKeyframeId
    panelProps.onUpdateSelectedKeyframe(selectedKeyframeId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    panelProps.onMoveSelectedKeyframe(selectedKeyframeId, 0.5)
    panelProps.onDuplicateSelectedKeyframe(selectedKeyframeId)

    const requestLog: unknown[] = []
    await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T15:00:00.000Z',
      writer: async (request: unknown) => {
        requestLog.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { boneId: string }) => keyframe.boneId), [
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
    ])
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), [
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1__copy-1',
    ])
    assert.equal(JSON.stringify((requestLog[0] as { sidecar: unknown }).sidecar).includes('Manual Chest'), false)
    assert.equal(JSON.stringify((requestLog[0] as { sidecar: unknown }).sidecar).includes('UniRig Spine'), false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D routes selected helper and overlay callbacks to the active rig authoring mode', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
    })
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const rigVisibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const poseVisibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const rigSelections: string[] = []
    const poseSelections: string[] = []

    const rigActive = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: rigVisibility,
      poseClipState: poseState,
      poseClipVisibility: poseVisibility,
    })
    assert.equal(rigActive.activeMode, 'rig-editor')
    assert.equal(rigActive.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')

    const rigOverlayProps = module.resolveViewer3DRigOverlayProps(rigActive, {
      onSelectBone: (boneId: string) => rigSelections.push(boneId),
    })
    assert.equal(rigOverlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    rigOverlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(rigSelections, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual([...poseSelections], [])

    const poseActive = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: module.createViewer3DRigEditorVisibilityState(rigSummary),
      poseClipState: poseState,
      poseClipVisibility: poseVisibility,
    })
    assert.equal(poseActive.activeMode, 'pose-clip')
    assert.equal(poseActive.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const poseOverlayProps = module.resolveViewer3DRigOverlayProps(poseActive, {
      onSelectBone: (boneId: string) => poseSelections.push(boneId),
    })
    assert.equal(poseOverlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    poseOverlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(rigSelections, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual(poseSelections, ['rig:hero|skeleton:0|bone:hips#0'])

    const inactive = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: module.createViewer3DRigEditorVisibilityState(rigSummary),
      poseClipState: poseState,
      poseClipVisibility: module.createViewer3DPoseClipVisibilityState(rigSummary),
    })
    assert.equal(inactive.activeMode, 'none')
    assert.equal(inactive.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.equal(module.resolveViewer3DRigOverlayProps(inactive, {}).overlay, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D shared selected target lets Rig Editor selection drive Pose/Clip props and overlay helper state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let sharedTarget = module.createViewer3DSelectedRigTargetState(rigSummary)
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    const rigVisibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const poseVisibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    rigState = { ...rigState, selectedBoneId: sharedTarget.selectedBoneId }
    poseState = { ...poseState, selectedBoneId: sharedTarget.selectedBoneId }

    assert.equal(module.resolveViewer3DRigEditorPanelProps(rigState, {}).selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(module.resolveViewer3DPoseClipPanelProps(poseState, {}).selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const activeTarget = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: rigVisibility,
      poseClipState: poseState,
      poseClipVisibility: poseVisibility,
      selectedTarget: sharedTarget,
    })
    const overlayProps = module.resolveViewer3DRigOverlayProps(activeTarget, {})

    assert.equal(activeTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(overlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(module.resolveViewer3DRigHelperStyles(rigSummary, activeTarget.selectedBoneId).markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'selected')
    assert.notEqual(poseState.plan.selectedBoneId, sharedTarget.selectedBoneId)
  } finally {
    await cleanup()
  }
})

test('Viewer3D shared selected target preserves Pose/Clip selection across panel close/reopen and resets only for invalid skeleton changes', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let sharedTarget = module.createViewer3DSelectedRigTargetState(rigSummary)
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    let poseVisibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: sharedTarget.selectedBoneId,
    })
    rigState = { ...rigState, selectedBoneId: sharedTarget.selectedBoneId }

    poseVisibility = module.reduceViewer3DPoseClipVisibilityState(poseVisibility, { type: 'close' })
    assert.equal(poseVisibility.isOpen, false)
    assert.equal(sharedTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    poseVisibility = module.reduceViewer3DPoseClipVisibilityState(poseVisibility, { type: 'toggle', summary: rigSummary })
    const reopenedPoseProps = module.resolveViewer3DPoseClipPanelProps({ ...poseState, selectedBoneId: sharedTarget.selectedBoneId }, {})
    const reopenedRigProps = module.resolveViewer3DRigEditorPanelProps({ ...rigState, selectedBoneId: sharedTarget.selectedBoneId }, {})
    const activeTarget = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: { ...rigState, selectedBoneId: sharedTarget.selectedBoneId },
      rigEditorVisibility: module.createViewer3DRigEditorVisibilityState(rigSummary),
      poseClipState: { ...poseState, selectedBoneId: sharedTarget.selectedBoneId },
      poseClipVisibility: poseVisibility,
      selectedTarget: sharedTarget,
    })

    assert.equal(reopenedPoseProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(reopenedRigProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(activeTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const sameSkeletonWithSelectedBone = { ...rigSummary, bones: [...rigSummary.bones] }
    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, { type: 'set-summary', summary: sameSkeletonWithSelectedBone })
    assert.equal(sharedTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, { type: 'set-summary', summary: secondRigSummary })
    assert.deepEqual(sharedTarget, {
      skeletonContextId: 'rig:creature|skeleton:0',
      selectedBoneId: 'rig:creature|skeleton:0|bone:root#0',
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D Pose/Clip drawer minimization preserves selected target and authored plan state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.75,
      rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
    })
    let sharedTarget = module.createViewer3DSelectedRigTargetState(rigSummary)
    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    let visibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    visibility = module.reduceViewer3DPoseClipVisibilityState(visibility, { type: 'set-drawer-mode', drawerMode: 'minimized' })
    assert.equal(visibility.isOpen, true)
    assert.equal(visibility.drawerMode, 'minimized')
    assert.equal(sharedTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(poseState.plan.keyframes.length, 1)

    visibility = module.reduceViewer3DPoseClipVisibilityState(visibility, { type: 'set-drawer-mode', drawerMode: 'expanded' })
    const expandedProps = module.resolveViewer3DPoseClipPanelProps({ ...poseState, selectedBoneId: sharedTarget.selectedBoneId }, {})

    assert.equal(visibility.drawerMode, 'expanded')
    assert.equal(expandedProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(expandedProps.keyframes.map((keyframe: { id: string }) => keyframe.id), ['kf-spine'])
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip save/load uses preload sidecar APIs with workspace-safe deterministic paths', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-1',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      timeSeconds: 0.4,
      rotation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 1)
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/pose-clips/hero.pose-clip.v1.json')
    assert.equal((requests[0] as { sourceWorkspacePath: string }).sourceWorkspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecar: { schema: string; source: { workspacePath: string }; skeletonContextId: string; keyframes: unknown[] } }).sidecar.schema, 'modly.pose-clip')
    assert.equal((requests[0] as { sidecar: { source: { workspacePath: string } } }).sidecar.source.workspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecar: { skeletonContextId: string } }).sidecar.skeletonContextId, 'rig:hero|skeleton:0')
    assert.equal((requests[0] as { sidecar: { keyframes: unknown[] } }).sidecar.keyframes.length, 1)
    assert.deepEqual(result, { success: true, sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar: (requests[0] as { sidecar: unknown }).sidecar })

    assert.deepEqual(module.resolveViewer3DPoseClipHydrationRequest(rigSummary), {
      sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip save/load regression stays renderer-to-Electron sidecar only and omits ephemeral timeline state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
    })

    const requests: unknown[] = []
    const result = await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T12:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 1)
    assert.deepEqual((requests[0] as { sidecarWorkspacePath: string; sourceWorkspacePath: string }), {
      sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
      sidecar: (requests[0] as { sidecar: unknown }).sidecar,
    })
    assert.equal(result.success, true)
    assert.deepEqual((requests[0] as { sidecar: { keyframes: { timeSeconds: number }[] } }).sidecar.keyframes.map((keyframe) => keyframe.timeSeconds), [0, 0.1])
    assert.deepEqual(Object.keys((requests[0] as { sidecar: Record<string, unknown> }).sidecar), ['schema', 'version', 'createdAt', 'source', 'skeletonContextId', 'clip', 'skeleton', 'keyframes'])
    assert.equal('currentTimeSeconds' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.equal('selectedKeyframeId' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.equal('selectedBoneId' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.deepEqual(module.resolveViewer3DPoseClipHydrationRequest(rigSummary), {
      sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D Pose/Clip seams avoid FastAPI orchestration, new IPC contracts, and source GLB export mutation paths', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const source = readFileSync(viewer3DEntry, 'utf8')
    const poseClipPanelSource = readFileSync(path.join(projectRoot, 'src/areas/generate/components/PoseClipPanel.tsx'), 'utf8')
    const poseClipPlanSource = readFileSync(path.join(projectRoot, 'src/areas/generate/poseClipPlan.ts'), 'utf8')
    const poseClipPreviewSource = readFileSync(path.join(projectRoot, 'src/areas/generate/poseClipPreview.ts'), 'utf8')
    const poseClipLogic = source.slice(
      source.indexOf('export function createViewer3DPoseClipState'),
      source.indexOf('export default function Viewer3D'),
    )
    const poseClipRuntimeHandlers = source.slice(
      source.indexOf('const handlePoseClipCurrentTimeChange'),
      source.indexOf('  useEffect(() => {', source.indexOf('const handleLoadPoseClipSidecar')),
    )
    const poseClipSource = [poseClipPanelSource, poseClipPlanSource, poseClipPreviewSource, poseClipLogic, poseClipRuntimeHandlers].join('\n')

    assert.equal(module.resolveViewer3DPoseClipHydrationRequest(rigSummary)?.sidecarWorkspacePath, 'Workflows/pose-clips/hero.pose-clip.v1.json')
    assert.match(poseClipRuntimeHandlers, /window\.electron\?\.workspace\?\.artifacts\?\.writePoseClipSidecar/)
    assert.match(poseClipRuntimeHandlers, /window\.electron\?\.workspace\?\.artifacts\?\.readPoseClipSidecar/)
    assert.doesNotMatch(poseClipSource, /fetch\s*\(|axios\.|useGeneration|workflowRun|createFromImage|processRun|FastAPI|8000\/generate|GLTFExporter|exportGLB|writePoseClipEmbedded/i)
    assert.doesNotMatch(poseClipSource, /ipcRenderer\.invoke\(['"](?!workspace:artifacts:(?:write|read)-pose-clip-sidecar)/)
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip hydration applies compatible sidecars and warns without retargeting incompatible data', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DPoseClipState(rigSummary)
    const token = module.createViewer3DPoseClipHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const sidecar = {
      schema: 'modly.pose-clip',
      version: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      skeletonContextId: 'rig:hero|skeleton:0',
      clip: { id: 'walk', name: 'Walk', durationSeconds: 1, fps: 24 },
      skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
      keyframes: [
        { id: 'kf-1', timeSeconds: 0.1, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { id: 'kf-missing', timeSeconds: 0.2, boneId: 'display-label-spine', rotation: { x: 1, y: 0, z: 0, w: 0 } },
      ],
    }

    const hydrated = module.applyViewer3DPoseClipHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.equal(hydrated.state.plan.clip.id, 'walk')
    assert.deepEqual(hydrated.state.plan.keyframes.map((keyframe: { boneId: string }) => keyframe.boneId), ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual(hydrated.warning, { status: 'warning', messages: ['Ignoring pose keyframes for unknown boneId "display-label-spine".'] })

    const invalid = module.applyViewer3DPoseClipHydrationResult({
      state,
      result: { success: false, status: 'invalid', sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', error: 'Pose clip sidecar JSON is invalid.' },
      token,
      currentToken: token,
    })
    assert.deepEqual(invalid.state.plan.keyframes, [])
    assert.deepEqual(invalid.warning, { status: 'warning', messages: ['Pose clip sidecar JSON is invalid.'] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip hydration resets UI-only playhead and selection while preserving compatible v1 keyframes', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DPoseClipState(rigSummary)
    state = module.reduceViewer3DPoseClipState(state, { type: 'set-current-time', timeSeconds: 0.75 })
    state = { ...state, selectedKeyframeId: 'stale-ui-selection' }
    const token = module.createViewer3DPoseClipHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const sidecar = {
      schema: 'modly.pose-clip',
      version: 1,
      createdAt: '2026-05-20T12:01:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      skeletonContextId: 'rig:hero|skeleton:0',
      clip: { id: 'loaded', name: 'Loaded', durationSeconds: 1, fps: 10 },
      skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
      keyframes: [
        { id: 'kf-loaded-0', timeSeconds: 0, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { id: 'kf-loaded-1', timeSeconds: 0.1, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 } },
      ],
    }

    const hydrated = module.applyViewer3DPoseClipHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.equal(hydrated.state.loadState, 'loaded')
    assert.equal(hydrated.state.currentTimeSeconds, 0)
    assert.equal(hydrated.state.selectedKeyframeId, undefined)
    assert.deepEqual(hydrated.state.plan.keyframes.map((keyframe: { id: string; timeSeconds: number }) => [keyframe.id, keyframe.timeSeconds]), [
      ['kf-loaded-0', 0],
      ['kf-loaded-1', 0.1],
    ])
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip preview pauses GLTF animation, evaluates stable-id bones, and restores snapshots on reset', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-1',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      timeSeconds: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-2',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      timeSeconds: 1,
      rotation: { x: 0, y: 1, z: 0, w: 0 },
    })
    const hip = new THREE.Bone()
    hip.quaternion.set(0.2, 0.3, 0.4, 0.5).normalize()
    const before = hip.quaternion.clone()
    const gltfAction = { enabled: true, paused: false, play: () => { throw new Error('GLTF animation must stay isolated during pose preview') } }

    const started = module.startViewer3DPoseClipPreview({
      state: poseState,
      bonesById: new Map([['rig:hero|skeleton:0|bone:hips#0', hip]]),
      gltfActions: [gltfAction],
      gltfAnimationPlaying: true,
      timeSeconds: 0.5,
    })

    assert.equal(gltfAction.paused, true)
    assert.equal(started.state.previewState, 'playing')
    assert.equal(started.gltfAnimationSnapshot.wasPlaying, true)
    assert.notDeepEqual(hip.quaternion.toArray(), before.toArray())

    const reset = module.resetViewer3DPoseClipPreview({
      state: started.state,
      bonesById: new Map([['rig:hero|skeleton:0|bone:hips#0', hip]]),
      snapshot: started.poseSnapshot,
    })

    assert.equal(reset.state.previewState, 'idle')
    assert.equal(reset.state.currentTimeSeconds, 0)
    assert.deepEqual(hip.quaternion.toArray(), before.toArray())
  } finally {
    await cleanup()
  }
})

test('Viewer3D timeline scrub restores the pose snapshot before evaluating and keeps GLTF animation isolated', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 24 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine-0',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine-1',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 1,
      rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)),
    })
    const hips = new THREE.Bone()
    const spine = new THREE.Bone()
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 7)
    const originalHips = hips.quaternion.clone()
    const snapshot = module.takeViewer3DPoseClipSnapshot(new Map([
      ['rig:hero|skeleton:0|bone:hips#0', hips],
      ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
    ]))
    const gltfAction = { enabled: true, paused: false, play: () => { throw new Error('timeline scrub must not resume GLTF animation') } }
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)

    const scrubbed = module.scrubViewer3DPoseClipPreviewTime({
      state: { ...poseState, previewState: 'playing' },
      bonesById: new Map([
        ['rig:hero|skeleton:0|bone:hips#0', hips],
        ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
      ]),
      poseSnapshot: snapshot,
      gltfActions: [gltfAction],
      gltfAnimationPlaying: true,
      timeSeconds: 0.5,
    })

    assert.equal(scrubbed.state.currentTimeSeconds, 0.5)
    assert.equal(scrubbed.state.previewState, 'paused')
    assert.equal(gltfAction.paused, true)
    assert.deepEqual(scrubbed.gltfAnimationSnapshot, { wasPlaying: true })
    assertQuaternionClose(hips.quaternion, originalHips)
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
  } finally {
    await cleanup()
  }
})

test('Viewer3D selecting and updating keyframes preview from a clean snapshot without mutating the stored snapshot', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.25,
      rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4)),
    })
    const spine = new THREE.Bone()
    spine.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 8)
    const originalSpine = spine.quaternion.clone()
    const bonesById = new Map([['rig:hero|skeleton:0|bone:hips#0/spine#0', spine]])
    const snapshot = module.takeViewer3DPoseClipSnapshot(bonesById)

    spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const selected = module.selectViewer3DPoseClipKeyframePreview({
      state: poseState,
      summary: rigSummary,
      bonesById,
      poseSnapshot: snapshot,
      gltfActions: [],
      gltfAnimationPlaying: false,
      keyframeId: 'kf-spine',
    })
    assert.equal(selected.state.currentTimeSeconds, 0.25)
    assert.equal(selected.state.selectedKeyframeId, 'kf-spine')
    assertQuaternionClose(snapshot.get('rig:hero|skeleton:0|bone:hips#0/spine#0'), originalSpine)
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4))

    const updatedRotation = quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3))
    const updated = module.updateViewer3DSelectedPoseClipKeyframePreview({
      state: module.reduceViewer3DPoseClipState(selected.state, { type: 'set-current-time', timeSeconds: 0.75 }),
      summary: rigSummary,
      bonesById,
      poseSnapshot: snapshot,
      gltfActions: [],
      gltfAnimationPlaying: false,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: updatedRotation,
    })

    assert.deepEqual(updated.state.plan.keyframes, [{ id: 'kf-spine', timeSeconds: 0.75, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: updatedRotation }])
    assertQuaternionClose(snapshot.get('rig:hero|skeleton:0|bone:hips#0/spine#0'), originalSpine)
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3))

    const reset = module.resetViewer3DPoseClipPreview({ state: updated.state, bonesById, snapshot })
    assert.equal(reset.state.previewState, 'idle')
    assertQuaternionClose(spine.quaternion, originalSpine)
  } finally {
    await cleanup()
  }
})

test('Viewer3D applies local Pose/Clip rotation to the selected RigBoneId, snapshots before edit, captures the modified quaternion, and resets without scene contamination', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const hips = new THREE.Bone()
    const spine = new THREE.Bone()
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 8)
    const originalHips = hips.quaternion.clone()
    const originalSpine = spine.quaternion.clone()
    const bonesById = new Map([
      ['rig:hero|skeleton:0|bone:hips#0', hips],
      ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
    ])

    const edited = module.applyViewer3DPoseClipLocalRotation({
      state: poseState,
      bonesById,
      poseSnapshot: null,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      axis: 'x',
      degreesDelta: 30,
    })

    assert.equal(edited.result.applied, true)
    assert.notEqual(edited.poseSnapshot, null)
    assert.deepEqual(hips.quaternion.toArray(), originalHips.toArray())
    assert.notDeepEqual(spine.quaternion.toArray(), originalSpine.toArray())

    poseState = module.reduceViewer3DPoseClipState(edited.state, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-edited-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.5,
      rotation: edited.result.rotation,
    })
    assert.deepEqual(poseState.plan.keyframes[0].rotation, edited.result.rotation)

    const reset = module.resetViewer3DPoseClipSelectedBone({
      state: poseState,
      bonesById,
      snapshot: edited.poseSnapshot,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    assert.deepEqual(reset.restoredBoneIds, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual(spine.quaternion.toArray(), originalSpine.toArray())
    assert.deepEqual(hips.quaternion.toArray(), originalHips.toArray())
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip timeline state clamps current time and keeps selection/playhead out of the sidecar', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'set-clip-metadata',
      summary: rigSummary,
      durationSeconds: 2,
      fps: 10,
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds: 3 })
    assert.equal(poseState.currentTimeSeconds, 2)

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds: -1 })
    assert.equal(poseState.currentTimeSeconds, 0)

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: poseState.plan.keyframes[0].id })

    const requests: unknown[] = []
    await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(poseState.selectedKeyframeId, poseState.plan.keyframes[0].id)
    assert.equal('selectedKeyframeId' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.equal('currentTimeSeconds' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D capture-and-advance captures at current time and advances by the default FPS step', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
    })
    assert.equal(poseState.plan.keyframes[0].timeSeconds, 0)
    assert.equal(poseState.currentTimeSeconds, 0.1)

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
    })

    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { timeSeconds: number }) => keyframe.timeSeconds), [0, 0.1])
    assert.equal(poseState.currentTimeSeconds, 0.2)
    assert.equal(poseState.selectedKeyframeId, poseState.plan.keyframes[1].id)
  } finally {
    await cleanup()
  }
})

test('Viewer3D legacy capture callback path derives deterministic IDs from bone, time, and FPS', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  const originalDateNow = Date.now

  try {
    Date.now = () => 987654321
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    const spineBoneId = 'rig:hero|skeleton:0|bone:hips#0/spine#0'
    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {
      onCaptureKeyframe: (boneId: string, timeSeconds: number) => {
        poseState = module.reduceViewer3DPoseClipState(poseState, {
          type: 'capture-keyframe',
          summary: rigSummary,
          boneId,
          timeSeconds,
          rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
        })
      },
    })

    panelProps.onCaptureKeyframe(spineBoneId, 0.25)
    panelProps.onCaptureKeyframe(spineBoneId, 0.25)

    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), [
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2',
    ])
    assert.equal(poseState.plan.keyframes.some((keyframe: { id: string }) => keyframe.id.includes('987654321')), false)
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { timeSeconds: number }) => keyframe.timeSeconds), [0.25, 0.25])
    assert.equal(poseState.selectedKeyframeId, 'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2')
  } finally {
    Date.now = originalDateNow
    await cleanup()
  }
})

test('Viewer3D minimized Pose/Clip panel props preserve stable capture IDs and display-only effective labels', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  const originalDateNow = Date.now

  try {
    Date.now = () => 987654321
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    rigState = {
      ...rigState,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(rigState, {}).effectiveNaming
    const calls: string[] = []
    const panelProps = module.resolveViewer3DPoseClipPanelProps(
      poseState,
      {
        drawerMode: 'minimized',
        onCurrentTimeChange: (timeSeconds: number) => {
          calls.push(`time:${timeSeconds}`)
          poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds })
        },
        onCaptureKeyframe: (boneId: string, timeSeconds: number) => {
          calls.push(`capture:${boneId}:${timeSeconds}`)
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'capture-keyframe',
            summary: rigSummary,
            boneId,
            timeSeconds,
            rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
          })
        },
        onPreviewPlay: () => calls.push('preview:play'),
        onPreviewReset: () => calls.push('preview:reset'),
        onSaveSidecar: () => calls.push('sidecar:save'),
        onLoadSidecar: () => calls.push('sidecar:load'),
      },
      effectiveNaming,
    )

    assert.equal(panelProps.drawerMode, 'minimized')
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(panelProps.rigDisplayNames.byBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].label, 'Manual Chest')

    panelProps.onCurrentTimeChange(0.25)
    panelProps.onCaptureKeyframe(panelProps.selectedBoneId, 0.25)
    panelProps.onCaptureKeyframe(panelProps.selectedBoneId, 0.25)
    panelProps.onPreviewPlay()
    panelProps.onPreviewReset()
    panelProps.onSaveSidecar()
    panelProps.onLoadSidecar()

    assert.deepEqual(calls, [
      'time:0.25',
      'capture:rig:hero|skeleton:0|bone:hips#0/spine#0:0.25',
      'capture:rig:hero|skeleton:0|bone:hips#0/spine#0:0.25',
      'preview:play',
      'preview:reset',
      'sidecar:save',
      'sidecar:load',
    ])
    assert.equal(calls.some((call) => /Manual|UniRig|Spine/.test(call)), false)
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), [
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2',
    ])
    assert.equal(poseState.plan.keyframes.some((keyframe: { id: string }) => keyframe.id.includes('987654321')), false)
  } finally {
    Date.now = originalDateNow
    await cleanup()
  }
})

test('Viewer3D selecting a pose keyframe positions playhead and selected target safely', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.5,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })

    const selected = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'kf-spine' })
    assert.equal(selected.selectedKeyframeId, 'kf-spine')
    assert.equal(selected.currentTimeSeconds, 0.5)
    assert.equal(selected.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(selected.plan.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const invalid = module.reduceViewer3DPoseClipState(selected, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'missing' })
    assert.equal(invalid.selectedKeyframeId, undefined)
    assert.equal(invalid.currentTimeSeconds, 0.5)
  } finally {
    await cleanup()
  }
})

test('Viewer3D updates and deletes the selected keyframe from current pose/time while preserving stable ids', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.25,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'kf-spine' })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds: 0.75 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'update-selected-keyframe',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0.3826834, y: 0, z: 0, w: 0.9238795 },
    })

    assert.deepEqual(poseState.plan.keyframes, [{
      id: 'kf-spine',
      timeSeconds: 0.75,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0.3826834, y: 0, z: 0, w: 0.9238795 },
    }])
    assert.equal(poseState.selectedKeyframeId, 'kf-spine')

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'delete-selected-keyframe', summary: rigSummary })
    assert.deepEqual(poseState.plan.keyframes, [])
    assert.equal(poseState.selectedKeyframeId, undefined)
  } finally {
    await cleanup()
  }
})

test('Viewer3D moves, shifts, and duplicates the selected keyframe through pure timeline helpers', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.4,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'kf-spine' })

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'move-selected-keyframe', summary: rigSummary, timeSeconds: 2 })
    assert.equal(poseState.plan.keyframes[0].timeSeconds, 1)
    assert.equal(poseState.currentTimeSeconds, 1)
    assert.equal(poseState.selectedKeyframeId, 'kf-spine')

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'shift-selected-keyframe', summary: rigSummary, deltaSeconds: -0.25 })
    assert.equal(poseState.plan.keyframes[0].timeSeconds, 0.75)
    assert.equal(poseState.currentTimeSeconds, 0.75)

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'duplicate-selected-keyframe', summary: rigSummary })
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), ['kf-spine', 'kf-spine__copy-1'])
    assert.equal(poseState.selectedKeyframeId, 'kf-spine__copy-1')
    assert.equal(poseState.currentTimeSeconds, 0.85)
  } finally {
    await cleanup()
  }
})

function quaternionValue(quaternion: THREE.Quaternion) {
  return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
}

function assertQuaternionClose(actual: THREE.Quaternion | undefined, expected: THREE.Quaternion, epsilon = 0.000001) {
  assert.ok(actual, 'expected quaternion to exist')
  assert.ok(Math.abs(actual.x - expected.x) <= epsilon, `x expected ${expected.x} got ${actual.x}`)
  assert.ok(Math.abs(actual.y - expected.y) <= epsilon, `y expected ${expected.y} got ${actual.y}`)
  assert.ok(Math.abs(actual.z - expected.z) <= epsilon, `z expected ${expected.z} got ${actual.z}`)
  assert.ok(Math.abs(actual.w - expected.w) <= epsilon, `w expected ${expected.w} got ${actual.w}`)
}
