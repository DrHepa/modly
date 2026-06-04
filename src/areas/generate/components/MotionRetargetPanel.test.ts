import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const motionRetargetPanelEntry = path.join(projectRoot, 'src/areas/generate/components/MotionRetargetPanel.tsx')

async function loadMotionRetargetPanelModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-motion-retarget-panel-'))
  const outfile = path.join(tempDir, 'MotionRetargetPanel.bundle.mjs')

  await build({
    entryPoints: [motionRetargetPanelEntry],
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

const rigSummary = {
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
}

const motionSession = {
  artifact: {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    previewGlbWorkspacePath: 'Workflows/kimodo/run-1/preview.glb',
    animatedGlbWorkspacePath: 'Workflows/kimodo/run-1/animated.glb',
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    diagnostics: {
      warnings: ['Root-motion correctness is deferred.'],
      raw: {},
    },
    motionRetarget: {
      status: 'parsed',
      diagnostics: [],
      clipName: 'Kimodo Walk Forward',
      sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
      mappingStatus: 'trusted_manual',
      mappingConfidence: 'compatible',
      fps: 30,
      durationSeconds: 1.5,
      timeSemantics: 'seconds',
      sourceBones: [
        { sourceBoneId: 'source:hips', label: 'Hips', rawLabel: 'Hips' },
        { sourceBoneId: 'source:spine', label: 'Spine', rawLabel: 'Spine', parentSourceBoneId: 'source:hips' },
      ],
      targetTracks: [
        {
          targetNodeName: 'Hips',
          targetNodeIndex: 0,
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1.5, x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
          ],
        },
        {
          targetNodeName: 'Spine',
          targetNodeIndex: 1,
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1.5, x: 0, y: 0, z: 0.7071068, w: 0.7071068 },
          ],
        },
      ],
    },
  },
  sourceBones: [
    { sourceBoneId: 'source:hips', label: 'Hips', rawLabel: 'Hips', path: ['Hips'] },
    { sourceBoneId: 'source:spine', label: 'Spine', rawLabel: 'Spine', path: ['Hips', 'Spine'], parentSourceBoneId: 'source:hips' },
  ],
  targetBones: [
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      label: 'UniRig Pelvis',
      rawLabel: 'Hips',
      labelProvenance: 'unirig',
      childIds: ['rig:hero|skeleton:0|bone:hips#0/spine#0'],
    },
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      label: 'Manual Chest',
      rawLabel: 'Spine',
      labelProvenance: 'manual',
      parentId: 'rig:hero|skeleton:0|bone:hips#0',
      childIds: [],
    },
  ],
  selectedPreview: 'animated-glb',
  mappings: {
    'source:hips': {
      sourceBoneId: 'source:hips',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0',
      targetLabel: 'UniRig Pelvis',
      targetLabelProvenance: 'unirig',
    },
    'source:spine': {
      sourceBoneId: 'source:spine',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      targetLabel: 'Manual Chest',
      targetLabelProvenance: 'manual',
    },
  },
  warnings: ['Root-motion correctness is deferred.'],
  diagnostics: {
    artifactWarnings: ['Root-motion correctness is deferred.'],
    mappingWarnings: [],
    sourceWarnings: {
      'source:hips': [],
      'source:spine': [],
    },
  },
  exportReadiness: {
    canSaveSidecar: true,
    canExportPoseClip: true,
    blockingWarnings: [],
  },
  unlockReadiness: {
    trustedPayloadReady: true,
    translationReady: true,
    showSourceBones: true,
    showMappingDisplay: true,
    canPreview: true,
    canSaveSidecar: true,
    canExportPoseClip: true,
    blockingWarnings: [],
  },
}

const motionSessionWithCompanion = {
  ...motionSession,
  artifact: {
    ...motionSession.artifact,
    diagnostics: {
      ...motionSession.artifact.diagnostics,
      raw: {
        pose_clip_companion: {
          schema: 'modly.pose-clip-companion',
          version: 1,
          clip: { id: 'kimodo walk/forward', name: 'Kimodo Walk Forward', durationSeconds: 1.5, fps: 30 },
          keyframes: [
            {
              id: 'hips-0',
              timeSeconds: 0,
              boneId: 'rig:hero|skeleton:0|bone:hips#0',
              rotation: { x: 0, y: 0, z: 0, w: 1 },
            },
            {
              id: 'spine-15',
              timeSeconds: 0.5,
              boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
              rotation: { x: 0, y: 0, z: 0.7071068, w: 0.7071068 },
              translation: { x: 9, y: 8, z: 7 },
              scale: { x: 2, y: 2, z: 2 },
            },
          ],
          root_translation: {
            mode: 'preserve_translation',
            samples: [{ timeSeconds: 0.5, translation: { x: 4, y: 5, z: 6 } }],
          },
        },
      },
    },
  },
}

const noRigSummary = {
  hasRig: false,
  skeletonContextId: 'rig:none|skeleton:0',
  skinnedMeshContexts: [],
  rootBoneIds: [],
  stats: { skinnedMeshCount: 0, boneCount: 0 },
  warnings: ['No skeleton bones were found.'],
  bones: [],
}

async function renderPanel(props: Record<string, unknown>) {
  const { module, cleanup } = await loadMotionRetargetPanelModule()

  try {
    return renderToStaticMarkup(createElement(module.MotionRetargetPanel, {
      summary: rigSummary,
        warnings: [],
        onSelectSourceBone: () => undefined,
        onChangeMapping: () => undefined,
        onSelectPreview: () => undefined,
        onSaveSidecar: () => undefined,
        onLoadSidecar: () => undefined,
        onExportPoseClipCompanion: () => undefined,
        ...props,
      }))
  } finally {
    await cleanup()
  }
}

async function withMotionRetargetPanelModule<T>(run: (module: Record<string, any>) => T | Promise<T>): Promise<T> {
  const { module, cleanup } = await loadMotionRetargetPanelModule()

  try {
    return await run(module)
  } finally {
    await cleanup()
  }
}

test('MotionRetargetPanel renders a clear no-rig empty state', async () => {
  const html = await renderPanel({ summary: noRigSummary })

  assert.match(html, /No rig for Motion Retarget/)
  assert.match(html, /Load a rigged character to inspect a Kimodo retarget session/)
  assert.doesNotMatch(html, /Preview asset/)
})

test('MotionRetargetPanel renders a readiness placeholder before a Kimodo session is loaded', async () => {
  const html = await renderPanel({ summary: rigSummary, session: undefined, selectedSourceBoneId: undefined })

  assert.match(html, /Motion Retarget/)
  assert.match(html, /No Kimodo motion session loaded yet/)
  assert.match(html, /Run a Kimodo animate mesh workflow or select its result to inspect retarget readiness/)
  assert.match(html, /2 bones/)
})

test('MotionRetargetPanel renders preview selection, display-only labels, and warnings for a loaded session', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:spine',
    selectedMapping: motionSession.mappings['source:spine'],
    warnings: motionSession.warnings,
  })

  assert.match(html, /Preview asset/)
  assert.match(html, /Animated GLB/)
  assert.match(html, /Preview GLB/)
  assert.match(html, /Manual Chest/)
  assert.match(html, /Name source: manual/)
  assert.match(html, /Root-motion correctness is deferred/)
  assert.match(html, /aria-label="Scrollable Motion Retarget content"/)
  assert.match(html, /overflow-y-auto/)
  assert.match(html, /tabindex="0"/)
})

test('MotionRetargetPanel production default shows actionable readiness instead of a raw diagnostic warning wall', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: {
      ...motionSession,
      warnings: [
        'invalid_basis',
        'basis/invalid_forward_axis',
        'visual_quality_not_validated',
        'Root-motion correctness is deferred.',
      ],
      diagnostics: {
        ...motionSession.diagnostics,
        artifactWarnings: [
          'invalid_basis',
          'basis/invalid_forward_axis',
          'visual_quality_not_validated',
          'Root-motion correctness is deferred.',
        ],
      },
    },
    warnings: [
      'invalid_basis',
      'basis/invalid_forward_axis',
      'visual_quality_not_validated',
      'Root-motion correctness is deferred.',
    ],
    animationPlaybackAvailable: true,
    previewDisabledReason: 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.',
  })

  assert.match(html, /Motion status/)
  assert.match(html, /Playable/)
  assert.match(html, /Adaptive correction/)
  assert.match(html, /Companion export/)
  assert.match(html, /Coherent\/export-ready/)
  assert.match(html, /Solver needs attention/)
  assert.match(html, /Adaptive correction is available, but coherent\/export-ready remains blocked by solver evidence\./)
  assert.match(html, /<details[^>]*>/)
  assert.match(html, /<summary[^>]*>Developer diagnostics/)
  assert.doesNotMatch(html, /<section role="status"[^>]*>\s*<p>invalid_basis<\/p>/)
  assert.doesNotMatch(html, /<details[^>]*open/)
})

test('MotionRetargetPanel readiness presenter keeps real solver failures visible without raw-code primary UX', async () => {
  await withMotionRetargetPanelModule((module) => {
    assert.deepEqual(module.resolveMotionRetargetPanelReadiness({
      session: {
        ...motionSession,
        warnings: ['basis/not_correction_eligible', 'visual_quality_warning'],
      },
      warnings: ['basis/not_correction_eligible', 'visual_quality_warning'],
      previewDisabledReason: undefined,
      animationPlaybackAvailable: true,
    }), {
      states: [
        { label: 'Playable', tone: 'ready', description: 'Animated or preview GLB playback is available.' },
        { label: 'Adaptive correction', tone: 'ready', description: 'Adaptive correction sidecar controls are available, but they do not prove solver coherence.' },
        { label: 'Companion export', tone: 'ready', description: 'Pose/Clip companion sidecar export is available as corrective metadata.' },
        { label: 'Coherent/export-ready', tone: 'blocked', description: 'Coherent solver/export readiness is blocked until basis, root, and visual evidence are valid.' },
        { label: 'Solver needs attention', tone: 'warning', description: 'Kimodo solver needs attention; visual quality is not yet validated.' },
      ],
      summary: 'Adaptive correction is available, but coherent/export-ready remains blocked by solver evidence.',
      diagnostics: ['basis/not_correction_eligible', 'visual_quality_warning'],
    })
  })
})

test('MotionRetargetPanel readiness presenter summarizes ready sessions without developer diagnostics', async () => {
  await withMotionRetargetPanelModule((module) => {
    assert.deepEqual(module.resolveMotionRetargetPanelReadiness({
      session: motionSession,
      warnings: [],
      previewDisabledReason: undefined,
      animationPlaybackAvailable: true,
    }), {
      states: [
        { label: 'Playable', tone: 'ready', description: 'Animated or preview GLB playback is available.' },
        { label: 'Adaptive correction', tone: 'ready', description: 'Adaptive correction sidecar controls are available, but they do not prove solver coherence.' },
        { label: 'Companion export', tone: 'ready', description: 'Pose/Clip companion sidecar export is available as corrective metadata.' },
        { label: 'Coherent/export-ready', tone: 'ready', description: 'Basis, root, and visual evidence currently support coherent solver/export readiness.' },
      ],
      summary: 'Ready for playback, adaptive correction sidecar edits, companion export, and coherent solver/export handoff.',
      diagnostics: [],
    })
  })
})

test('MotionRetargetPanel separates adaptive correction availability from coherent/export-ready status', async () => {
  const invalidSolverSession = {
    ...motionSession,
    artifact: {
      ...motionSession.artifact,
      diagnostics: {
        ...motionSession.artifact.diagnostics,
        solverStatus: 'preview',
        basisStatus: 'invalid',
        rootMotionStatus: 'preserve_root_motion',
        visualQualityStatus: 'warning',
        warnings: ['basis/invalid_forward_axis', 'visual_quality_warning', 'Root-motion correctness is deferred.'],
      },
    },
    warnings: ['basis/invalid_forward_axis', 'visual_quality_warning', 'Root-motion correctness is deferred.'],
    exportReadiness: {
      ...motionSession.exportReadiness,
      coherentExportReady: false,
      blockingWarnings: ['Kimodo solver result is not coherent/export-ready: basis is invalid.'],
    },
  }
  const html = await renderPanel({
    summary: rigSummary,
    session: invalidSolverSession,
    warnings: invalidSolverSession.warnings,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: invalidSolverSession.mappings['source:hips'],
    correctionMessage: 'Loaded Motion Retarget corrections: Workflows/motion-retarget/mrt_hash.motion-retarget.v1.json',
    correctionDirty: false,
  })

  assert.match(html, /Adaptive correction/)
  assert.match(html, /Loaded Motion Retarget corrections/)
  assert.match(html, /Companion export/)
  assert.match(html, /Coherent\/export-ready/)
  assert.match(html, /Adaptive correction is available, but coherent\/export-ready remains blocked by solver evidence\./)
  assert.match(html, /Solver needs attention/)
  assert.doesNotMatch(html, /strict mode/i)
})

test('MotionRetargetPanel renders mapping rows for source bones and target rig options when compatible source data exists', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
  })

  assert.match(html, /Manual mapping/)
  assert.match(html, /Source Hips|Hips/)
  assert.match(html, /Source Spine|Spine/)
  assert.match(html, /Target rig bone for Hips/)
  assert.match(html, /Target rig bone for Spine/)
  assert.match(html, /UniRig Pelvis/)
  assert.match(html, /Manual Chest/)
})

test('MotionRetargetPanel explains manual mapping edits affect the session sidecar and do not rewrite generated animated GLB', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
  })

  assert.match(html, /Manual mapping/)
  assert.match(html, /Manual mapping edits affect only this local preview, session sidecar, and future companion exports/)
  assert.match(html, /They do not rewrite the already generated animated GLB/)
})

test('MotionRetargetPanel exposes save and load sidecar actions when a session is savable', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
  })

  assert.match(html, /Save motion retarget sidecar/)
  assert.match(html, /Load motion retarget sidecar/)
  assert.match(html, /<button type="button" aria-label="Save motion retarget sidecar" title="Save motion retarget sidecar" class=/)
})

test('MotionRetargetPanel exposes adaptive correction controls with honest preview/save copy', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    corrections: {
      rootTranslationPolicy: 'preserve_scaled_npz',
      rootMotionScale: 1.25,
      rootOffset: { x: 0.4, y: 0, z: -0.2 },
      previewMode: 'after',
    },
    correctionMessage: 'Unsaved Motion Retarget corrections for this artifact.',
    correctionDirty: true,
  })

  assert.match(html, /Adaptive correction/)
  assert.match(html, /Preview correction/)
  assert.match(html, /Save correction/)
  assert.match(html, /Root translation/)
  assert.match(html, /Root motion scale/)
  assert.match(html, /Root offset X/)
  assert.match(html, /Root offset Z/)
  assert.match(html, /Before/)
  assert.match(html, /After/)
  assert.match(html, /Unsaved Motion Retarget corrections for this artifact\./)
  assert.match(html, /Adaptive correction changes the preview and sidecar only/)
  assert.doesNotMatch(html, /strict mode/i)
})

test('MotionRetargetPanel correction helpers route normalized root edits and reset events', async () => {
  await withMotionRetargetPanelModule((module) => {
    const received: unknown[] = []

    module.handleMotionRetargetCorrectionNumberChange({
      field: 'rootMotionScale',
      value: '2.5',
      corrections: {
        rootTranslationPolicy: 'solver',
        rootMotionScale: 1,
        rootOffset: { x: 0, y: 0, z: 0 },
        previewMode: 'after',
      },
      onChangeCorrections: (corrections: unknown) => received.push(corrections),
    })
    module.handleMotionRetargetCorrectionVectorChange({
      axis: 'z',
      value: '-0.75',
      corrections: received[0],
      onChangeCorrections: (corrections: unknown) => received.push(corrections),
    })
    module.handleMotionRetargetCorrectionReset({
      onChangeCorrections: (corrections: unknown) => received.push(corrections),
    })

    assert.deepEqual(received, [
      { rootTranslationPolicy: 'solver', rootMotionScale: 2.5, rootOffset: { x: 0, y: 0, z: 0 }, previewMode: 'after' },
      { rootTranslationPolicy: 'solver', rootMotionScale: 2.5, rootOffset: { x: 0, y: 0, z: -0.75 }, previewMode: 'after' },
      { rootTranslationPolicy: 'solver', rootMotionScale: 1, rootOffset: { x: 0, y: 0, z: 0 }, previewMode: 'after' },
    ])
  })
})

test('MotionRetargetPanel exposes an Export Pose/Clip companion action when trusted translated Kimodo motion metadata is available', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    exportDisabledReason: undefined,
  })

  assert.match(html, /Export Pose\/Clip companion/)
  assert.match(html, /Write an additive Pose\/Clip v1 companion sidecar without overwriting authored Pose\/Clip files\./)
  assert.match(html, /aria-label="Export Pose\/Clip companion"/)
  assert.doesNotMatch(html, /trusted Kimodo motion payload/i)
})

test('MotionRetargetPanel exposes renderer-owned open and download action buttons for relevant Kimodo artifacts', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    artifactLinks: [
      {
        key: 'metadata',
        label: 'Metadata JSON',
        workspacePath: 'Workflows/kimodo/run-1/metadata.json',
        downloadName: 'kimodo-run-1-metadata.json',
      },
      {
        key: 'motion-bvh',
        label: 'Motion BVH',
        workspacePath: 'Workflows/kimodo/run-1/motion.bvh',
        downloadName: 'kimodo-run-1-motion.bvh',
      },
    ],
  })

  assert.match(html, /Kimodo artifacts/)
  assert.match(html, /Metadata JSON/)
  assert.match(html, /Motion BVH/)
  assert.doesNotMatch(html, /href=/)
  assert.doesNotMatch(html, /download=/)
  assert.doesNotMatch(html, /target="_blank"/)
  assert.match(html, /Open Metadata JSON/)
  assert.match(html, /Download Motion BVH/)
  assert.match(html, /<button type="button" aria-label="Open Metadata JSON" title="Open Metadata JSON" class=/)
  assert.match(html, /<button type="button" aria-label="Download Motion BVH" title="Download Motion BVH" class=/)
})

test('MotionRetargetPanel enables local rotation-only preview controls only when a trusted translated Kimodo motion payload exists', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    previewDisabledReason: undefined,
    previewState: 'paused',
    previewCurrentTimeSeconds: 0.5,
    previewDurationSeconds: 1.5,
  })

  assert.match(html, /Local rotation-only preview/)
  assert.match(html, /Scrub local quaternion preview without mutating the source GLB or bind pose\./)
  assert.match(html, /aria-label="Play motion retarget preview"/)
  assert.match(html, /aria-label="Reset motion retarget preview"/)
  assert.match(html, /aria-label="Motion retarget preview time"/)
  assert.doesNotMatch(html, /trusted Kimodo motion payload/i)
})

test('MotionRetargetPanel keeps local rotation-only preview disabled with a clear reason when only diagnostics are available', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    previewDisabledReason: 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.',
    previewState: 'idle',
    previewCurrentTimeSeconds: 0,
    previewDurationSeconds: 0,
  })

  assert.match(html, /Local rotation-only preview/)
  assert.match(html, /Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks\./)
  assert.match(html, /aria-label="Play motion retarget preview"[^>]*disabled/)
  assert.match(html, /aria-label="Reset motion retarget preview"[^>]*disabled/)
})

test('MotionRetargetPanel keeps animated GLB playback available when local retarget preview is diagnostics-only', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    previewDisabledReason: 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.',
    previewState: 'idle',
    previewCurrentTimeSeconds: 0,
    previewDurationSeconds: 0,
    animationPlaybackAvailable: true,
    animationPlaybackActive: false,
  })

  assert.match(html, /Local rotation-only preview/)
  assert.match(html, /Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks\./)
  assert.match(html, /aria-label="Play animated GLB"/)
  assert.doesNotMatch(html, /aria-label="Play animated GLB"[^>]*disabled=""/)
  assert.match(html, /aria-label="Reset animated GLB playback"/)
  assert.doesNotMatch(html, /aria-label="Reset animated GLB playback"[^>]*disabled=""/)
})

test('MotionRetargetPanel keeps active-backend Reset available for playable animated GLB even when local retarget preview is blocked', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    previewDisabledReason: 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.',
    previewState: 'idle',
    previewCurrentTimeSeconds: 0.9,
    previewDurationSeconds: 0,
    animationPlaybackAvailable: true,
    animationPlaybackActive: true,
  })

  assert.match(html, /aria-label="Pause animated GLB"/)
  assert.match(html, /aria-label="Reset animated GLB playback"/)
  assert.doesNotMatch(html, /aria-label="Reset animated GLB playback"[^>]*disabled=""/)
  assert.match(html, />Reset animated GLB</)
})

test('MotionRetargetPanel keeps Export Pose/Clip companion disabled with a clear reason when companion metadata is absent', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    exportDisabledReason: 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.',
  })

  assert.match(html, /Export Pose\/Clip companion/)
  assert.match(html, /disabled/)
  assert.match(html, /Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose\/Clip companion output path\./)
})

test('MotionRetargetPanel target selection routes sourceBoneId and target RigBoneId through its mapping change helper', async () => {
  await withMotionRetargetPanelModule((module) => {
    const received: Array<{ sourceBoneId: string, targetBoneId?: string }> = []

    module.handleMotionRetargetMappingChange({
      sourceBoneId: 'source:spine',
      value: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      onSelectSourceBone: (sourceBoneId: string) => received.push({ sourceBoneId }),
      onChangeMapping: (sourceBoneId: string, targetBoneId?: string) => received.push({ sourceBoneId, targetBoneId }),
    })

    assert.deepEqual(received, [
      { sourceBoneId: 'source:spine' },
      { sourceBoneId: 'source:spine', targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0' },
    ])
  })
})

test('MotionRetargetPanel mapping rows expose role and chain hints instead of only raw source labels', async () => {
  await withMotionRetargetPanelModule((module) => {
    const rows = module.resolveMotionRetargetPanelMappingRows({
      ...motionSession,
      sourceBones: [
        { sourceBoneId: 'source:left-hand', label: 'Left Hand', rawLabel: 'L_Wrist_JNT', path: ['Root', 'L_Wrist_JNT'], role: 'left_hand', chain: 'left_arm' },
        { sourceBoneId: 'source:left-index', label: 'Left Index', rawLabel: 'L_Index_01', path: ['Root', 'L_Index_01'], role: 'left_index_1', chain: 'left_fingers' },
      ],
      mappings: {
        'source:left-hand': { sourceBoneId: 'source:left-hand' },
        'source:left-index': { sourceBoneId: 'source:left-index' },
      },
    }, rigSummary)

    assert.deepEqual(rows.map((row) => row.sourceMetaText), [
      'Role: left hand · Chain: left arm',
      'Role: left index 1 · Chain: left fingers',
    ])
  })
})

test('MotionRetargetPanel diagnostics-only state does not fabricate mapping controls when no source bones exist', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: {
      ...motionSession,
      sourceBones: [],
      mappings: {},
      exportReadiness: {
        ...motionSession.exportReadiness,
        canExportPoseClip: false,
      },
    },
    warnings: ['Diagnostics-only inspection is available until Kimodo exports source bone metadata.'],
  })

  assert.match(html, /Diagnostics-only inspection is available until Kimodo exports source bone metadata/)
  assert.doesNotMatch(html, /Manual mapping/)
  assert.doesNotMatch(html, /Target rig bone for/)
})

test('MotionRetargetPanel keeps its body in an internal scroll region when diagnostics and artifact sections grow taller than the viewport cap', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: motionSession,
    selectedSourceBoneId: 'source:hips',
    selectedMapping: motionSession.mappings['source:hips'],
    warnings: [
      'Diagnostics-only inspection is available until Kimodo exports a trusted motion payload/source bone metadata.',
      'Trusted Kimodo motion payload is unavailable.',
    ],
    artifactLinks: Array.from({ length: 6 }, (_, index) => ({
      key: `artifact-${index}`,
      label: `Artifact ${index + 1}`,
      workspacePath: `Workflows/kimodo/run-1/artifact-${index + 1}.json`,
      downloadName: `artifact-${index + 1}.json`,
    })),
  })

  assert.match(html, /aria-label="Motion Retarget panel" class="flex h-full min-h-0 max-h-full flex-col gap-4 overflow-hidden/)
  assert.match(html, /aria-label="Scrollable Motion Retarget content" tabindex="0" class="min-h-0 flex-1 overflow-y-auto pr-1"/)
  assert.match(html, /class="space-y-4 pb-6"/)
  assert.match(html, /Artifact 6/)
})

test('MotionRetargetPanel keeps save disabled with a clear reason when the session is diagnostics-only', async () => {
  const html = await renderPanel({
    summary: rigSummary,
    session: {
      ...motionSession,
      sourceBones: [],
      mappings: {},
      exportReadiness: {
        ...motionSession.exportReadiness,
        canSaveSidecar: false,
        canExportPoseClip: false,
      },
    },
    saveDisabledReason: 'Save is unavailable until Kimodo exports source bone metadata.',
  })

  assert.match(html, /Save motion retarget sidecar/)
  assert.match(html, /disabled/)
  assert.match(html, /Save is unavailable until Kimodo exports source bone metadata/)
})

test('MotionRetargetPanel compacts repeated accepted role-drift diagnostics into a workable summary', async () => {
  await withMotionRetargetPanelModule((module) => {
    const warnings = [
      'Kimodo target track "bone_5" accepted exact local identity for role "hips"; local role metadata is missing.',
      'Kimodo target track "bone_4" accepted exact local identity; local role metadata "neck" differs from Kimodo role "spine".',
      'Kimodo target track "bone_9" accepted exact local identity; local role metadata "left_hand" differs from Kimodo role "right_foot".',
      'Kimodo target track "left_index_1" is missing local target for node index 99.',
      'Kimodo target track "right_index_1" is missing local target for node index 100.',
      'Kimodo target track "left_index_2" is missing local target for node index 101.',
      'Root-motion correctness is deferred.',
    ]

    assert.deepEqual(module.compactMotionRetargetPanelWarnings(warnings), [
      'Accepted 3 Kimodo target tracks with local role metadata drift; stable bone identity was used for local preview/session export.',
      '3 optional Kimodo target tracks are not present in the local rig and were skipped for the partial local preview/export.',
      'Root-motion correctness is deferred.',
    ])
  })
})
