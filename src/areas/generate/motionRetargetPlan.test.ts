import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMotionRetargetCorrectionIdentity,
  createMotionRetargetSession,
  createMotionRetargetSidecarV1,
  hydrateMotionRetargetSessionSnapshotFromSidecar,
  reduceMotionRetargetSession,
  resolveMotionRetargetCorrectionState,
  type MotionRetargetSession,
  type MotionRetargetSourceBone,
} from './motionRetargetPlan.ts'
import type { KimodoMotionArtifact } from './kimodoMotionAdapter.ts'
import type { RigMetaNamingMap } from './rigMetaNaming.ts'
import type { RigRenamePlan } from './rigRenamePlan.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

const rigSummary: RigSkeletonSummary = {
  hasRig: true,
  sourceWorkspacePath: 'Workflows/generated/hero.glb',
  skeletonContextId: 'rig:Hero|skeleton:0',
  skinnedMeshContexts: ['rig:Hero|skeleton:0'],
  rootBoneIds: ['bone:hips'],
  stats: { skinnedMeshCount: 1, boneCount: 4 },
  warnings: [],
  bones: [
    {
      boneId: 'bone:hips',
      label: 'Hips',
      originalName: 'Hips',
      path: ['Hips'],
      siblingIndex: 0,
      childIds: ['bone:spine'],
      warnings: [],
    },
    {
      boneId: 'bone:spine',
      label: 'Spine',
      originalName: 'Spine',
      path: ['Hips', 'Spine'],
      siblingIndex: 0,
      parentId: 'bone:hips',
      childIds: ['bone:left-arm'],
      warnings: [],
    },
    {
      boneId: 'bone:left-arm',
      label: 'Arm',
      originalName: 'Arm',
      path: ['Hips', 'Spine', 'Arm'],
      siblingIndex: 0,
      parentId: 'bone:spine',
      childIds: ['bone:left-hand'],
      warnings: ['duplicate-name'],
    },
    {
      boneId: 'bone:left-hand',
      label: 'Hand',
      originalName: 'Hand',
      path: ['Hips', 'Spine', 'Arm', 'Hand'],
      siblingIndex: 0,
      parentId: 'bone:left-arm',
      childIds: [],
      warnings: [],
    },
  ],
}

const sourceBones: MotionRetargetSourceBone[] = [
  { sourceBoneId: 'src:hips', label: 'Source Hips', rawLabel: 'Source Hips', path: ['Source Hips'] },
  { sourceBoneId: 'src:spine', label: 'Source Spine', rawLabel: 'Source Spine', path: ['Source Hips', 'Source Spine'], parentSourceBoneId: 'src:hips' },
  { sourceBoneId: 'src:arm', label: 'Source Arm', rawLabel: 'Source Arm', path: ['Source Hips', 'Source Spine', 'Source Arm'], parentSourceBoneId: 'src:spine' },
]

const rigMetaNaming: RigMetaNamingMap = {
  'bone:hips': { label: 'Pelvis', source: 'humanoid_contract' },
}

const renamePlan: RigRenamePlan = {
  skeletonContextId: rigSummary.skeletonContextId,
  aliases: {
    'bone:left-arm': { oldLabel: 'Arm', alias: 'Manual Left Arm' },
  },
}

function createArtifact(overrides: Partial<KimodoMotionArtifact> = {}): KimodoMotionArtifact {
  return {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    workflowId: 'workflow-1',
    workflowNodeId: 'node-1',
    previewGlbWorkspacePath: 'Workflows/kimodo/run-1/preview.glb',
    animatedGlbWorkspacePath: 'Workflows/kimodo/run-1/animated.glb',
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    diagnostics: {
      runtimeStatus: 'success',
      retargetStatus: 'success',
      animationMappingStatus: 'trusted_contract',
      stabilizationStatus: 'not_evaluated',
      visualQualityStatus: 'warning',
      sourceKind: 'load_mesh_existing',
      mappingConfidence: 'compatible',
      retargetErrorCode: null,
      retargetErrorAliases: [],
      retargetErrorMessage: null,
      warnings: ['visual_quality_warning', 'root_motion_mode_preserve_translation'],
      raw: {},
    },
    motionRetarget: {
      status: 'parsed',
      diagnostics: [],
      clipName: 'Kimodo Walk',
      sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
      mappingStatus: 'trusted_manual',
      mappingConfidence: 'compatible',
      fps: 24,
      durationSeconds: 1,
      timeSemantics: 'seconds',
      sourceBones: [
        { sourceBoneId: 'src:hips', label: 'Source Hips', rawLabel: 'Source Hips', role: 'hips' },
        { sourceBoneId: 'src:spine', label: 'Source Spine', rawLabel: 'Source Spine', role: 'spine', parentSourceBoneId: 'src:hips' },
        { sourceBoneId: 'src:arm', label: 'Source Arm', rawLabel: 'Source Arm', role: 'left_arm', chain: 'left_arm', parentSourceBoneId: 'src:spine' },
      ],
      targetTracks: [
        {
          targetNodeName: 'Hips',
          targetNodeIndex: 0,
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1, x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
          ],
        },
        {
          targetNodeName: 'Spine',
          targetNodeIndex: 1,
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1, x: 0, y: 0, z: 0.7071068, w: 0.7071068 },
          ],
        },
        {
          targetNodeName: 'Arm',
          targetNodeIndex: 2,
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1, x: 0.7071068, y: 0, z: 0, w: 0.7071068 },
          ],
        },
      ],
    },
    ...overrides,
  }
}

function createSession(overrides: Partial<MotionRetargetSession> = {}): MotionRetargetSession {
  const base = createMotionRetargetSession({
    artifact: createArtifact(),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  return {
    ...base,
    ...overrides,
  }
}

test('createMotionRetargetSession hydrates mappings, auto-prefers animated preview, aggregates warnings, and resolves labels with manual > unirig > raw precedence', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact(),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
    snapshot: {
      mappings: {
        'src:hips': { targetBoneId: 'bone:hips' },
        'src:arm': { targetBoneId: 'bone:left-arm' },
      },
    },
  })

  assert.equal(session.selectedPreview, 'animated-glb')
  assert.equal(session.mappings['src:hips']?.targetLabel, 'Pelvis')
  assert.equal(session.mappings['src:hips']?.targetLabelProvenance, 'unirig')
  assert.equal(session.mappings['src:arm']?.targetLabel, 'Manual Left Arm')
  assert.equal(session.mappings['src:arm']?.targetLabelProvenance, 'manual')
  assert.equal(session.targetBones.find((bone) => bone.boneId === 'bone:spine')?.label, 'Spine')
  assert.equal(session.targetBones.find((bone) => bone.boneId === 'bone:spine')?.labelProvenance, 'raw')
  assert.deepEqual(session.sourceBones.map((bone) => ({ sourceBoneId: bone.sourceBoneId, role: bone.role, chain: bone.chain })), [
    { sourceBoneId: 'src:hips', role: 'hips', chain: undefined },
    { sourceBoneId: 'src:spine', role: 'spine', chain: undefined },
    { sourceBoneId: 'src:arm', role: 'left_arm', chain: 'left_arm' },
  ])
  assert.deepEqual(session.diagnostics.mappingWarnings, ['Source bone "Source Spine" is not mapped.'])
  assert.deepEqual(session.warnings, [
    'visual_quality_warning',
    'root_motion_mode_preserve_translation',
    'Source bone "Source Spine" is not mapped.',
  ])
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.equal(session.unlockReadiness.canPreview, true)
  assert.equal(session.unlockReadiness.showSourceBones, true)
  assert.equal(session.unlockReadiness.showMappingDisplay, true)
})

test('reduceMotionRetargetSession hydrates snapshots defensively, flags duplicate targets and preserves parent continuity warnings', () => {
  const baseSession = createMotionRetargetSession({
    artifact: createArtifact({ animatedGlbWorkspacePath: undefined }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  const hydrated = reduceMotionRetargetSession(baseSession, {
    type: 'hydrate',
    snapshot: {
      selectedPreview: 'animated-glb',
      mappings: {
        'src:hips': { targetBoneId: 'bone:hips' },
        'src:spine': { targetBoneId: 'bone:left-hand' },
        'src:arm': { targetBoneId: 'bone:left-hand' },
        'src:unknown': { targetBoneId: 'bone:left-arm' },
      },
    },
  })

  assert.equal(hydrated.selectedPreview, 'preview-glb')
  assert.equal(hydrated.mappings['src:hips']?.targetLabel, 'Pelvis')
  assert.equal(hydrated.mappings['src:spine']?.targetLabel, 'Hand')
  assert.deepEqual(hydrated.diagnostics.sourceWarnings['src:spine'], [
    'Target bone "Hand" is assigned to multiple source bones.',
    'Source bone "Source Spine" is mapped outside its parent continuity.',
  ])
  assert.deepEqual(hydrated.diagnostics.sourceWarnings['src:arm'], [
    'Target bone "Hand" is assigned to multiple source bones.',
  ])
  assert.deepEqual(hydrated.diagnostics.mappingWarnings, [
    'Target bone "Hand" is assigned to multiple source bones.',
    'Source bone "Source Spine" is mapped outside its parent continuity.',
  ])
  assert.equal(hydrated.exportReadiness.canExportPoseClip, true)
  assert.equal(hydrated.unlockReadiness.canPreview, true)
})

test('reduceMotionRetargetSession updates mappings and preview immutably while ignoring unknown source and unavailable preview selections', () => {
  const session = createSession()
  const before = structuredClone(session)

  const mapped = reduceMotionRetargetSession(session, {
    type: 'set-mapping',
    sourceBoneId: 'src:spine',
    targetBoneId: 'bone:spine',
  })

  assert.deepEqual(session, before)
  assert.equal(mapped.mappings['src:spine']?.targetBoneId, 'bone:spine')
  assert.deepEqual(mapped.diagnostics.mappingWarnings, [
    'Source bone "Source Hips" is not mapped.',
    'Source bone "Source Arm" is not mapped.',
  ])

  const previewAttempt = reduceMotionRetargetSession(mapped, {
    type: 'set-preview',
    selectedPreview: 'preview-glb',
  })
  assert.equal(previewAttempt.selectedPreview, 'preview-glb')

  const ignored = reduceMotionRetargetSession(previewAttempt, {
    type: 'set-mapping',
    sourceBoneId: 'src:missing',
    targetBoneId: 'bone:hips',
  })
  assert.deepEqual(ignored, previewAttempt)
})

test('createMotionRetargetSession fails closed for legacy, invalid, untrusted, or ambiguous translated motion payloads', () => {
  const legacy = createMotionRetargetSession({
    artifact: createArtifact({ motionRetarget: undefined }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(legacy.unlockReadiness.canPreview, false)
  assert.equal(legacy.unlockReadiness.showSourceBones, false)
  assert.equal(legacy.unlockReadiness.showMappingDisplay, false)
  assert.equal(legacy.exportReadiness.canSaveSidecar, false)
  assert.equal(legacy.exportReadiness.canExportPoseClip, false)
  assert.match(legacy.exportReadiness.blockingWarnings.join('\n'), /trusted kimodo motion payload/i)

  const invalid = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        status: 'invalid',
        diagnostics: ['Kimodo motion retarget contract version must be 1.'],
        sourceBones: [],
        targetTracks: [],
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.match(invalid.exportReadiness.blockingWarnings.join('\n'), /contract version must be 1/i)

  const untrusted = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: { schema: 'modly.humanoid.v1', trusted: false },
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.match(untrusted.exportReadiness.blockingWarnings.join('\n'), /trusted kimodo motion payload/i)

  const ambiguousSummary: RigSkeletonSummary = {
    ...rigSummary,
    bones: rigSummary.bones.map((bone) => bone.boneId === 'bone:left-hand'
      ? { ...bone, originalName: 'Arm', nodeIndex: 2 }
      : bone),
  }
  const ambiguous = createMotionRetargetSession({
    artifact: createArtifact(),
    targetSummary: ambiguousSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(ambiguous.unlockReadiness.canPreview, false)
  assert.match(ambiguous.exportReadiness.blockingWarnings.join('\n'), /ambiguous local target/i)
})

test('createMotionRetargetSession distinguishes preview unlock from full correctness for incomplete live-shape payloads', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecarPayloadSha256: 'live-shape-hash',
          sidecarWorkspacePath: 'Workflows/kimodo/run-1/source-contract.sidecar.json',
        },
        coverage: {
          rootTranslation: { status: 'missing', reason: 'Kimodo suppressed root translation.' },
          body: { coveredRoles: ['hips', 'spine'], expectedRoles: ['hips', 'spine', 'left_leg', 'right_leg'] },
          hands: { status: 'insufficient', coveredRoles: ['left_hand'], expectedRoles: ['left_hand', 'right_hand'] },
          fingers: { status: 'missing', coveredRoles: [], expectedRoles: ['left_index', 'right_index'] },
        },
        omittedChannels: [
          { targetNodeName: 'Hips', channel: 'translation', reason: 'PoseClip v1 is rotation-only.' },
        ],
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.playbackAvailable, true)
  assert.equal(session.unlockReadiness.localRetargetReady, true)
  assert.equal(session.unlockReadiness.canPreview, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.match(session.warnings.join('\n'), /root translation/i)
  assert.match(session.warnings.join('\n'), /omitted translation/i)
  assert.match(session.warnings.join('\n'), /hand/i)
  assert.match(session.warnings.join('\n'), /finger/i)
})

test('createMotionRetargetSession does not trust partial manual-confirmed evidence or UI naming to unlock local retarget', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      diagnostics: {
        ...createArtifact().diagnostics,
        animationMappingStatus: 'manual_confirmed',
      },
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecarPayloadSha256: 'live-shape-hash',
        },
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
    snapshot: {
      mappings: {
        'src:hips': { targetBoneId: 'bone:hips' },
        'src:spine': { targetBoneId: 'bone:spine' },
        'src:arm': { targetBoneId: 'bone:left-arm' },
      },
    },
  })

  assert.equal(session.unlockReadiness.playbackAvailable, true)
  assert.equal(session.unlockReadiness.localRetargetReady, false)
  assert.equal(session.unlockReadiness.trustedPayloadReady, false)
  assert.match(session.exportReadiness.blockingWarnings.join('\n'), /manual_confirmed/i)
  assert.match(session.exportReadiness.blockingWarnings.join('\n'), /hash and workspace path/i)
})

test('createMotionRetargetSession unlocks scoped manual-confirmed local preview while preserving full-correctness diagnostics', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      diagnostics: {
        ...createArtifact().diagnostics,
        animationMappingStatus: 'manual_confirmed',
      },
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecarPayloadSha256: 'a'.repeat(64),
          sidecarWorkspacePath: 'Workflows/avatars/manual.humanoid-promotion.v1.json',
          sourceMeshWorkspacePath: 'Workflows/avatars/manual.glb',
          sourceMeshSha256: 'b'.repeat(64),
        },
        coverage: {
          rootTranslation: { status: 'complete' },
          body: {
            status: 'partial',
            coveredRoles: ['left_arm', 'right_arm', 'left_leg', 'right_leg'],
            expectedRoles: ['torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg'],
            reason: 'torso coverage 4/5',
          },
          hands: { status: 'complete', coveredRoles: ['left_hand', 'right_hand'], expectedRoles: ['left_hand', 'right_hand'] },
          fingers: {
            status: 'omitted',
            coveredRoles: [],
            expectedRoles: ['left_fingers', 'right_fingers'],
            reason: 'source_or_target_finger_tracks_unavailable',
          },
        },
        omittedChannels: [
          { targetNodeName: '*', channel: 'finger_rotation', reason: 'source_or_target_finger_tracks_unavailable' },
        ],
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.playbackAvailable, true)
  assert.equal(session.unlockReadiness.trustedPayloadReady, true)
  assert.equal(session.unlockReadiness.translationReady, true)
  assert.equal(session.unlockReadiness.localRetargetReady, true)
  assert.equal(session.unlockReadiness.canPreview, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.match(session.warnings.join('\n'), /body coverage/i)
  assert.match(session.warnings.join('\n'), /finger coverage/i)
  assert.match(session.warnings.join('\n'), /omitted finger_rotation/i)
})

test('createMotionRetargetSession unlocks manual workbench for partial translated body tracks and keeps unresolved tracks as warnings', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecarPayloadSha256: 'safe-manual-hash',
          sidecarWorkspacePath: 'Workflows/kimodo/run-1/source-contract.sidecar.json',
        },
        targetTracks: [
          { targetNodeName: 'Hips', targetNodeIndex: 90, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
          { targetNodeName: 'Spine', targetNodeIndex: 91, targetRole: 'spine', rotations: [{ timeSeconds: 0, x: 0, y: 0.2, z: 0, w: 0.98 }] },
          { targetNodeName: 'missing_finger', targetNodeIndex: 92, targetRole: 'left_index_1', rotations: [{ timeSeconds: 0, x: 0, y: 0.1, z: 0, w: 0.99 }] },
        ],
        coverage: {
          body: { status: 'partial', coveredRoles: ['hips', 'spine'], expectedRoles: ['hips', 'spine', 'neck'], reason: 'neck omitted' },
          fingers: { status: 'omitted', coveredRoles: [], expectedRoles: ['left_fingers'], reason: 'source_or_target_finger_tracks_unavailable' },
        },
      },
    }),
    targetSummary: {
      ...rigSummary,
      bones: rigSummary.bones.map((bone, index) => ({
        ...bone,
        nodeIndex: 100 + index,
        role: bone.boneId === 'bone:hips' ? 'hips' : bone.boneId === 'bone:spine' ? 'spine' : bone.role,
      })),
    },
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.trustedPayloadReady, true)
  assert.equal(session.unlockReadiness.translationReady, true)
  assert.equal(session.unlockReadiness.localRetargetReady, true)
  assert.equal(session.unlockReadiness.canPreview, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.match(session.exportReadiness.blockingWarnings.join('\n'), /missing local target/i)
  assert.match(session.warnings.join('\n'), /finger coverage/i)
})

test('createMotionRetargetSession disables only unsafe local preview when Kimodo omits basis rest-pose evidence', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        omittedChannels: [
          { targetNodeName: '*', channel: 'basis_rest_pose', reason: 'basis/rest-pose evidence not emitted by solver export' },
        ],
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.canPreview, false)
  assert.equal(session.unlockReadiness.localRetargetReady, false)
  assert.equal(session.unlockReadiness.trustedPayloadReady, true)
  assert.equal(session.unlockReadiness.translationReady, true)
  assert.equal(session.unlockReadiness.showSourceBones, true)
  assert.equal(session.unlockReadiness.showMappingDisplay, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.equal(session.unlockReadiness.canSaveSidecar, true)
  assert.equal(session.unlockReadiness.canExportPoseClip, true)
  assert.match(session.warnings.join('\n'), /Local rotation preview disabled because Kimodo omitted basis\/rest-pose evidence; use animated GLB playback or export sidecar for rerun\./)
})

test('createMotionRetargetSession disables unsafe local preview when Kimodo marks basis invalid but keeps manual sidecar/export honest', () => {
  const artifact = createArtifact({
    diagnostics: {
      ...createArtifact().diagnostics,
      solverStatus: 'preview',
      basisStatus: 'invalid',
      rootMotionStatus: 'preserve_root_motion',
      visualQualityStatus: 'warning',
      warnings: [
        'basis/invalid_forward_axis',
        'basis/invalid_up_axis',
        'basis_corrected_rotation_channels_skipped_invalid_basis',
      ],
    },
  })

  const session = createMotionRetargetSession({
    artifact,
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.playbackAvailable, true)
  assert.equal(session.unlockReadiness.trustedPayloadReady, true)
  assert.equal(session.unlockReadiness.translationReady, true)
  assert.equal(session.unlockReadiness.localRetargetReady, false)
  assert.equal(session.unlockReadiness.canPreview, false)
  assert.equal(session.unlockReadiness.canSaveSidecar, true)
  assert.equal(session.unlockReadiness.canExportPoseClip, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.equal(session.exportReadiness.coherentExportReady, false)
  assert.match(session.exportReadiness.blockingWarnings.join('\n'), /not coherent\/export-ready/i)
  assert.match(session.unlockReadiness.blockingWarnings.join('\n'), /basis invalid/i)
  assert.match(session.warnings.join('\n'), /basis_corrected_rotation_channels_skipped_invalid_basis/)
})

test('adaptive correction availability does not imply coherent export readiness when visual/root evidence remains warning', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      diagnostics: {
        ...createArtifact().diagnostics,
        solverStatus: 'preview',
        basisStatus: 'warning',
        rootMotionStatus: 'preserve_root_motion',
        visualQualityStatus: 'warning',
        warnings: ['visual_quality_warning', 'Root-motion correctness is deferred.'],
      },
    }),
    targetSummary: rigSummary,
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.equal(session.exportReadiness.coherentExportReady, false)
  assert.match(session.exportReadiness.blockingWarnings.join('\n'), /visual quality is not validated/i)
  assert.match(session.exportReadiness.blockingWarnings.join('\n'), /root-motion correctness is deferred/i)
})

test('createMotionRetargetSession treats exact identity role drift as diagnostic warning instead of blocking readiness', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecarPayloadSha256: 'exact-identity-hash',
          sidecarWorkspacePath: 'Workflows/kimodo/run-1/source-contract.sidecar.json',
        },
        targetTracks: [
          { targetNodeName: 'bone_5', targetNodeIndex: 0, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
          { targetNodeName: 'bone_4', targetNodeIndex: 1, targetRole: 'spine', rotations: [{ timeSeconds: 0, x: 0, y: 0.2, z: 0, w: 0.98 }] },
        ],
      },
    }),
    targetSummary: {
      ...rigSummary,
      stats: { skinnedMeshCount: 1, boneCount: 2 },
      bones: [
        { ...rigSummary.bones[0], boneId: 'bone:hips', originalName: 'bone_5', nodeIndex: 0, role: undefined, childIds: ['bone:spine'] },
        { ...rigSummary.bones[1], boneId: 'bone:spine', originalName: 'bone_4', nodeIndex: 1, role: 'neck', parentId: 'bone:hips', childIds: [] },
      ],
    },
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.translationReady, true)
  assert.equal(session.unlockReadiness.localRetargetReady, true)
  assert.equal(session.unlockReadiness.canPreview, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.match(session.warnings.join('\n'), /role metadata is missing/i)
  assert.match(session.warnings.join('\n'), /role metadata "neck" differs from Kimodo role "spine"/i)
  assert.doesNotMatch(session.warnings.join('\n'), /failed role mismatch/i)
})

test('createMotionRetargetSession treats unique originalName role drift with divergent node index as safe local identity', () => {
  const session = createMotionRetargetSession({
    artifact: createArtifact({
      motionRetarget: {
        ...createArtifact().motionRetarget!,
        sourceContract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecarPayloadSha256: 'unique-original-name-hash',
          sidecarWorkspacePath: 'Workflows/kimodo/run-1/source-contract.sidecar.json',
        },
        targetTracks: [
          { targetNodeName: 'bone_5', targetNodeIndex: 0, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
          { targetNodeName: 'bone_4', targetNodeIndex: 1, targetRole: 'spine', rotations: [{ timeSeconds: 0, x: 0, y: 0.2, z: 0, w: 0.98 }] },
        ],
      },
    }),
    targetSummary: {
      ...rigSummary,
      stats: { skinnedMeshCount: 1, boneCount: 2 },
      bones: [
        { ...rigSummary.bones[0], boneId: 'bone:hips', originalName: 'bone_5', nodeIndex: 42, role: undefined, childIds: ['bone:spine'] },
        { ...rigSummary.bones[1], boneId: 'bone:spine', originalName: 'bone_4', nodeIndex: 43, role: 'neck', parentId: 'bone:hips', childIds: [] },
      ],
    },
    sourceBones,
    renamePlan,
    rigMetaNamingByBoneId: rigMetaNaming,
  })

  assert.equal(session.unlockReadiness.translationReady, true)
  assert.equal(session.unlockReadiness.canPreview, true)
  assert.equal(session.exportReadiness.canSaveSidecar, true)
  assert.equal(session.exportReadiness.canExportPoseClip, true)
  assert.match(session.warnings.join('\n'), /role metadata is missing/i)
  assert.match(session.warnings.join('\n'), /role metadata "neck" differs from Kimodo role "spine"/i)
  assert.doesNotMatch(session.warnings.join('\n'), /failed role mismatch/i)
})

test('Motion Retarget correction identity is artifact-bound beyond the GLB filename', () => {
  const baseSession = createSession()
  const baseIdentity = createMotionRetargetCorrectionIdentity({
    sourceWorkspacePath: rigSummary.sourceWorkspacePath,
    skeletonContextId: rigSummary.skeletonContextId,
    artifact: baseSession.artifact,
  })
  const sameFilenameDifferentWorkflow = createMotionRetargetCorrectionIdentity({
    sourceWorkspacePath: rigSummary.sourceWorkspacePath,
    skeletonContextId: rigSummary.skeletonContextId,
    artifact: createArtifact({
      workflowId: 'workflow-2',
      workflowNodeId: 'node-2',
      bundleWorkspacePath: 'Workflows/kimodo/run-2',
      metadataWorkspacePath: 'Workflows/kimodo/run-2/metadata.json',
      previewGlbWorkspacePath: 'Workflows/kimodo/run-2/preview.glb',
      animatedGlbWorkspacePath: 'Workflows/kimodo/run-2/animated.glb',
    }),
  })
  const sameWorkflowDifferentSource = createMotionRetargetCorrectionIdentity({
    sourceWorkspacePath: 'Workflows/generated/creature.glb',
    skeletonContextId: rigSummary.skeletonContextId,
    artifact: baseSession.artifact,
  })

  assert.match(baseIdentity.key, /^mrt_[a-f0-9]{16}$/)
  assert.equal(baseIdentity.sourceWorkspacePath, 'Workflows/generated/hero.glb')
  assert.equal(baseIdentity.workflowId, 'workflow-1')
  assert.equal(baseIdentity.artifactWorkspacePath, 'Workflows/kimodo/run-1/animated.glb')
  assert.notEqual(baseIdentity.key, sameFilenameDifferentWorkflow.key)
  assert.notEqual(baseIdentity.key, sameWorkflowDifferentSource.key)
})

test('Motion Retarget sidecar serializes and hydrates source bones, mappings, corrections, and load state only for matching identity', () => {
  const session = reduceMotionRetargetSession(createSession(), {
    type: 'set-mapping',
    sourceBoneId: 'src:spine',
    targetBoneId: 'bone:spine',
  })
  const identity = createMotionRetargetCorrectionIdentity({
    sourceWorkspacePath: rigSummary.sourceWorkspacePath,
    skeletonContextId: rigSummary.skeletonContextId,
    artifact: session.artifact,
  })
  const corrections = {
    rootTranslationPolicy: 'preserve_scaled_npz' as const,
    rootMotionScale: 1.25,
    rootOffset: { x: 0.1, y: 0.2, z: -0.3 },
    previewMode: 'after' as const,
  }
  const sidecar = createMotionRetargetSidecarV1({
    identity,
    session,
    sourceWorkspacePath: rigSummary.sourceWorkspacePath,
    createdAt: '2026-05-24T20:10:00.000Z',
    corrections,
    warnings: ['Loaded from sidecar.'],
  })
  const loaded = hydrateMotionRetargetSessionSnapshotFromSidecar({
    sidecar,
    identity,
  })
  const differentIdentity = createMotionRetargetCorrectionIdentity({
    sourceWorkspacePath: 'Workflows/generated/other.glb',
    skeletonContextId: rigSummary.skeletonContextId,
    artifact: session.artifact,
  })
  const rejected = hydrateMotionRetargetSessionSnapshotFromSidecar({
    sidecar,
    identity: differentIdentity,
  })

  assert.equal(sidecar.identity.key, identity.key)
  assert.deepEqual(sidecar.sourceBones.map((bone) => bone.sourceBoneId), ['src:hips', 'src:spine', 'src:arm'])
  assert.deepEqual(sidecar.session.mappings, {
    'src:spine': { targetBoneId: 'bone:spine' },
  })
  assert.deepEqual(sidecar.corrections, corrections)
  assert.deepEqual(loaded, {
    status: 'loaded',
    snapshot: sidecar.session,
    sourceBones: sidecar.sourceBones,
    corrections,
    warnings: [],
  })
  assert.equal(rejected.status, 'identity-mismatch')
  assert.match(rejected.warnings.join('\n'), /different workflow\/artifact identity/i)
})

test('Motion Retarget correction state represents idle, dirty, saved, loaded, and error UI plumbing', () => {
  const clean = resolveMotionRetargetCorrectionState({ status: 'idle' })
  const dirty = resolveMotionRetargetCorrectionState({ status: 'dirty', lastLoadedIdentityKey: 'mrt_old', currentIdentityKey: 'mrt_new' })
  const saved = resolveMotionRetargetCorrectionState({ status: 'saved', sidecarWorkspacePath: 'Workflows/motion-retarget/mrt_hash.motion-retarget.v1.json' })
  const loaded = resolveMotionRetargetCorrectionState({ status: 'loaded', sidecarWorkspacePath: 'Workflows/motion-retarget/mrt_hash.motion-retarget.v1.json' })
  const error = resolveMotionRetargetCorrectionState({ status: 'error', message: 'Invalid sidecar.' })

  assert.deepEqual(clean, { status: 'idle', dirty: false, message: 'No saved correction sidecar loaded.' })
  assert.deepEqual(dirty, { status: 'dirty', dirty: true, message: 'Unsaved Motion Retarget corrections for this artifact.' })
  assert.deepEqual(saved, { status: 'saved', dirty: false, message: 'Saved Motion Retarget corrections: Workflows/motion-retarget/mrt_hash.motion-retarget.v1.json' })
  assert.deepEqual(loaded, { status: 'loaded', dirty: false, message: 'Loaded Motion Retarget corrections: Workflows/motion-retarget/mrt_hash.motion-retarget.v1.json' })
  assert.deepEqual(error, { status: 'error', dirty: false, message: 'Invalid sidecar.' })
})
