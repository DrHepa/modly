import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import {
  normalizeKimodoMotionArtifact,
  type KimodoMotionArtifact,
} from './kimodoMotionAdapter.ts'

function createKimodoArtifact(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    id: 'artifact-kimodo',
    kind: 'mesh',
    uri: '/workspace/Workflows/kimodo/run-1/animated.glb',
    versionId: 'artifact-kimodo-original',
    legacy: { filePath: '/workspace/Workflows/kimodo/run-1/animated.glb', outputType: 'mesh' },
    provenance: {
      workflowId: 'workflow-1',
      workflowNodeId: 'animate-node',
      extensionId: 'kimodo-soma-rp',
      extensionNodeId: 'animate-rigged-mesh',
    },
    ...overrides,
  }
}

function expectSuccess(result: ReturnType<typeof normalizeKimodoMotionArtifact>): KimodoMotionArtifact {
  assert.equal(result.ok, true)
  return result.artifact
}

test('normalizeKimodoMotionArtifact consumes animate-rigged-mesh bundle metadata into workspace-safe Modly diagnostics', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      animation_mapping_status: 'trusted_contract',
      stabilization_status: 'not_evaluated',
      visual_quality_status: 'warning',
      clip_name: 'Kimodo Motion',
      source_kind: 'load_mesh_existing',
      mapping_confidence: 'compatible',
      canonical_motion_artifact: 'motion.npz',
      artifacts: ['animated.glb', 'metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
      warnings: ['visual_quality_warning', 'root_motion_mode_preserve_translation'],
      retarget_error_aliases: [],
      diagnostics: {
        bvh_path: 'motion.bvh',
        visual_quality: { version: 'kimodo.visual_quality.v1', blocking: false },
      },
    },
  })

  assert.deepEqual(expectSuccess(result), {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    workflowId: 'workflow-1',
    workflowNodeId: 'animate-node',
    previewGlbWorkspacePath: 'Workflows/kimodo/run-1/preview.glb',
    animatedGlbWorkspacePath: 'Workflows/kimodo/run-1/animated.glb',
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    canonicalMotionArtifactWorkspacePath: 'Workflows/kimodo/run-1/motion.npz',
    motionNpzWorkspacePath: 'Workflows/kimodo/run-1/motion.npz',
    motionBvhWorkspacePath: 'Workflows/kimodo/run-1/motion.bvh',
    diagnostics: {
      runtimeStatus: 'success',
      retargetStatus: 'success',
      solverStatus: null,
      basisStatus: null,
      rootMotionStatus: null,
      animationMappingStatus: 'trusted_contract',
      stabilizationStatus: 'not_evaluated',
      visualQualityStatus: 'warning',
      sourceKind: 'load_mesh_existing',
      mappingConfidence: 'compatible',
      retargetErrorCode: null,
      retargetErrorAliases: [],
      retargetErrorMessage: null,
      warnings: ['visual_quality_warning', 'root_motion_mode_preserve_translation'],
      raw: {
        runtime_status: 'success',
        retarget_status: 'success',
        animation_mapping_status: 'trusted_contract',
        stabilization_status: 'not_evaluated',
        visual_quality_status: 'warning',
        clip_name: 'Kimodo Motion',
        source_kind: 'load_mesh_existing',
        mapping_confidence: 'compatible',
        canonical_motion_artifact: 'motion.npz',
        artifacts: ['animated.glb', 'metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
        warnings: ['visual_quality_warning', 'root_motion_mode_preserve_translation'],
        retarget_error_aliases: [],
        diagnostics: {
          bvh_path: 'motion.bvh',
          visual_quality: { version: 'kimodo.visual_quality.v1', blocking: false },
        },
      },
    },
  })
})

test('normalizeKimodoMotionArtifact preserves Kimodo solver contract statuses for unsafe local-preview gating', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-invalid-basis',
    metadataWorkspacePath: 'Workflows/kimodo/run-invalid-basis/metadata.json',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      solver_status: 'preview',
      basis_status: 'invalid',
      root_motion_status: 'preserve_root_motion',
      visual_quality_status: 'warning',
      source_kind: 'load_mesh_existing',
      mapping_confidence: 'compatible',
      artifacts: ['animated.glb', 'metadata.json', 'preview.glb'],
      warnings: [
        'basis/invalid_forward_axis',
        'basis/invalid_up_axis',
        'basis_corrected_rotation_channels_skipped_invalid_basis',
      ],
    },
  })

  const normalized = expectSuccess(result)
  assert.equal(normalized.diagnostics.solverStatus, 'preview')
  assert.equal(normalized.diagnostics.basisStatus, 'invalid')
  assert.equal(normalized.diagnostics.rootMotionStatus, 'preserve_root_motion')
  assert.equal(normalized.diagnostics.visualQualityStatus, 'warning')
  assert.deepEqual(normalized.diagnostics.warnings, [
    'basis/invalid_forward_axis',
    'basis/invalid_up_axis',
    'basis_corrected_rotation_channels_skipped_invalid_basis',
  ])
})

test('normalizeKimodoMotionArtifact preserves source authority without converting warnings into solver success', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-npz-authority',
    metadataWorkspacePath: 'Workflows/kimodo/run-npz-authority/metadata.json',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      solver_status: 'preview',
      basis_status: 'invalid',
      root_motion_status: 'preserve_root_motion',
      visual_quality_status: 'warning',
      source_authority: 'soma77_npz',
      source_contract: 'soma77_npz_v1',
      bvh_role: 'debug_export_only',
      fallback_diagnostics: ['BVH retained for debug/export only.'],
      artifacts: ['animated.glb', 'metadata.json', 'motion.npz', 'motion.bvh', 'preview.glb'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 1,
        source_authority: 'soma77_npz',
        source_contract: { schema: 'modly.humanoid.v1', trusted: true },
        bvh_role: 'debug_export_only',
        fallback_diagnostics: ['BVH retained for debug/export only.'],
        mapping_status: 'trusted_manual',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1,
        source_bones: [{ source_bone_id: 'src:hips', label: 'Source Hips', raw_label: 'Hips' }],
        target_tracks: [
          { target_node_name: 'Hips', target_node_index: 0, rotations: [{ time_seconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
        ],
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.equal(normalized.diagnostics.sourceAuthority, 'soma77_npz')
  assert.equal(normalized.diagnostics.sourceContract, 'soma77_npz_v1')
  assert.equal(normalized.diagnostics.bvhRole, 'debug_export_only')
  assert.deepEqual(normalized.diagnostics.fallbackDiagnostics, ['BVH retained for debug/export only.'])
  assert.equal(normalized.diagnostics.basisStatus, 'invalid')
  assert.equal(normalized.diagnostics.visualQualityStatus, 'warning')
  assert.equal(normalized.motionRetarget?.sourceAuthority, 'soma77_npz')
  assert.equal(normalized.motionRetarget?.bvhRole, 'debug_export_only')
  assert.deepEqual(normalized.motionRetarget?.fallbackDiagnostics, ['BVH retained for debug/export only.'])
})

test('normalizeKimodoMotionArtifact parses kimodo.motion-retarget.v1 blocks into normalized source bones and rotation-only target tracks', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      animation_mapping_status: 'trusted_contract',
      source_kind: 'load_mesh_existing',
      mapping_confidence: 'compatible',
      clip_name: 'Kimodo Walk Forward',
      artifacts: ['animated.glb', 'metadata.json', 'preview.glb'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 1,
        source_contract: { schema: 'modly.humanoid.v1', trusted: true, sidecar_payload_sha256: 'abc123' },
        mapping_status: 'trusted_manual',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1.5,
        time_semantics: 'seconds',
        source_bones: [
          {
            source_bone_id: 'src:hips',
            label: 'Source Hips',
            raw_label: 'Hips',
          },
        ],
        target_tracks: [
          {
            target_node_name: 'Hips',
            target_node_index: 0,
            rotations: [
              { time_seconds: 0, x: 0, y: 0, z: 0, w: 1 },
              { time_seconds: 0.5, x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
            ],
          },
        ],
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.deepEqual(normalized.motionRetarget, {
    status: 'parsed',
    diagnostics: [],
    clipName: 'Kimodo Walk Forward',
    sourceContract: { schema: 'modly.humanoid.v1', trusted: true, sidecarPayloadSha256: 'abc123' },
    mappingStatus: 'trusted_manual',
    mappingConfidence: 'compatible',
    fps: 30,
    durationSeconds: 1.5,
    timeSemantics: 'seconds',
    sourceBones: [
      {
        sourceBoneId: 'src:hips',
        label: 'Source Hips',
        rawLabel: 'Hips',
      },
    ],
    targetTracks: [
      {
        targetNodeName: 'Hips',
        targetNodeIndex: 0,
        rotations: [
          { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
          { timeSeconds: 0.5, x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
        ],
      },
    ],
  })
})

test('normalizeKimodoMotionArtifact accepts Kimodo live-shape camelCase timeSeconds rotations without degrading to diagnostics-only', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-camel',
    metadataWorkspacePath: 'Workflows/kimodo/run-camel/metadata.json',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      animation_mapping_status: 'manual_confirmed',
      source_kind: 'load_mesh_existing',
      mapping_confidence: 'compatible',
      clip_name: 'Kimodo Live Shape',
      artifacts: ['animated.glb', 'metadata.json', 'preview.glb'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 1,
        source_contract: { schema: 'modly.humanoid-promotion.v1', trusted: true, sidecar_payload_sha256: 'live-shape' },
        mapping_status: 'manual_confirmed',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1,
        time_semantics: 'seconds',
        source_bones: [
          {
            source_bone_id: 'src:hips',
            label: 'Source Hips',
            raw_label: 'Hips',
          },
        ],
        target_tracks: [
          {
            target_node_name: 'bone_5',
            target_node_index: 5,
            target_role: 'hips',
            rotations: [
              { timeSeconds: 0, x: 0.539, y: 0.457, z: 0.455, w: 0.541 },
              { timeSeconds: 0.0333333333, x: 0.54, y: 0.458, z: 0.456, w: 0.542 },
            ],
          },
        ],
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.equal(normalized.motionRetarget?.status, 'parsed')
  assert.equal(normalized.motionRetarget?.targetTracks.length, 1)
  assert.deepEqual(normalized.motionRetarget?.targetTracks[0], {
    targetNodeName: 'bone_5',
    targetNodeIndex: 5,
    targetRole: 'hips',
    rotations: [
      { timeSeconds: 0, x: 0.539, y: 0.457, z: 0.455, w: 0.541 },
      { timeSeconds: 0.0333333333, x: 0.54, y: 0.458, z: 0.456, w: 0.542 },
    ],
  })
  assert.deepEqual(normalized.diagnostics.warnings, [])
})

test('normalizeKimodoMotionArtifact preserves scoped manual-confirmed contract evidence and honest coverage diagnostics', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-diagnostics',
    metadataWorkspacePath: 'Workflows/kimodo/run-diagnostics/metadata.json',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      animation_mapping_status: 'manual_confirmed',
      source_kind: 'load_mesh_existing',
      mapping_confidence: 'compatible',
      clip_name: 'Kimodo Diagnostic Shape',
      artifacts: ['animated.glb', 'metadata.json', 'preview.glb'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 1,
        source_contract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          sidecar_payload_sha256: 'live-shape-hash',
          sidecar_workspace_path: 'source-contract.sidecar.json',
        },
        mapping_status: 'manual_confirmed',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1,
        time_semantics: 'seconds',
        omitted_channels: [
          { target_node_name: 'bone_5', channel: 'translation', reason: 'PoseClip v1 is rotation-only.' },
          { target_node_name: 'bone_9', channel: 'scale', reason: 'Scale channels are future transform-clip metadata only.' },
        ],
        coverage: {
          root_translation: { status: 'missing', reason: 'Kimodo did not emit target-local root translation.' },
          body: { covered_roles: ['hips', 'spine'], expected_roles: ['hips', 'spine', 'left_leg', 'right_leg'] },
          hands: { status: 'insufficient', covered_roles: ['left_hand'], expected_roles: ['left_hand', 'right_hand'] },
          fingers: { status: 'missing', covered_roles: [], expected_roles: ['left_index', 'right_index'] },
        },
        transform_tracks: [
          {
            target_node_name: 'bone_5',
            target_node_index: 5,
            translations: [{ time_seconds: 0, x: 1, y: 2, z: 3 }],
          },
        ],
        source_bones: [
          { source_bone_id: 'src:hips', label: 'Source Hips', raw_label: 'Hips', role: 'hips' },
          { source_bone_id: 'src:left_hand', label: 'Source Left Hand', raw_label: 'LeftHand', role: 'left_hand' },
        ],
        target_tracks: [
          {
            target_node_name: 'bone_5',
            target_node_index: 5,
            target_role: 'hips',
            rotations: [
              { time_seconds: 0, x: 0, y: 0, z: 0, w: 1 },
              { time_seconds: 1, x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
            ],
          },
        ],
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.deepEqual(normalized.motionRetarget?.sourceContract, {
    schema: 'modly.humanoid-promotion.v1',
    trusted: false,
    status: 'manual_confirmed',
    sidecarPayloadSha256: 'live-shape-hash',
    sidecarWorkspacePath: 'Workflows/kimodo/run-diagnostics/source-contract.sidecar.json',
  })
  assert.deepEqual(normalized.motionRetarget?.omittedChannels, [
    { targetNodeName: 'bone_5', channel: 'translation', reason: 'PoseClip v1 is rotation-only.' },
    { targetNodeName: 'bone_9', channel: 'scale', reason: 'Scale channels are future transform-clip metadata only.' },
  ])
  assert.deepEqual(normalized.motionRetarget?.coverage, {
    rootTranslation: { status: 'missing', reason: 'Kimodo did not emit target-local root translation.' },
    body: { coveredRoles: ['hips', 'spine'], expectedRoles: ['hips', 'spine', 'left_leg', 'right_leg'] },
    hands: { status: 'insufficient', coveredRoles: ['left_hand'], expectedRoles: ['left_hand', 'right_hand'] },
    fingers: { status: 'missing', coveredRoles: [], expectedRoles: ['left_index', 'right_index'] },
  })
  assert.deepEqual(normalized.motionRetarget?.futureTransformTracks, [
    {
      targetNodeName: 'bone_5',
      targetNodeIndex: 5,
      translations: [{ timeSeconds: 0, x: 1, y: 2, z: 3 }],
    },
  ])
  assert.equal(normalized.motionRetarget?.status, 'parsed')
  assert.equal(normalized.motionRetarget?.targetTracks.length, 1)
})

test('normalizeKimodoMotionArtifact bridges manual-confirmed contract path and solver coverage into scoped evidence', () => {
  const artifact = createKimodoArtifact()

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-scoped',
    metadataWorkspacePath: 'Workflows/kimodo/run-scoped/metadata.json',
    sourceMeshWorkspacePath: 'Workflows/avatars/manual.glb',
    metadata: {
      runtime_status: 'success',
      retarget_status: 'success',
      animation_mapping_status: 'manual_confirmed',
      source_workspace_path: 'Workflows/avatars/manual.glb',
      artifacts: ['animated.glb', 'metadata.json', 'preview.glb'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 1,
        source_contract: {
          schema: 'modly.humanoid-promotion.v1',
          trusted: false,
          status: 'manual_confirmed',
          path: '/home/drhepa/Documentos/Modly/workspace/Workflows/avatars/manual.humanoid-promotion.v1.json',
          sidecar_payload_sha256: 'a'.repeat(64),
          source_mesh_workspace_path: 'Workflows/avatars/manual.glb',
          source_mesh_sha256: 'b'.repeat(64),
        },
        mapping_status: 'manual_confirmed',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1,
        source_bones: [
          { source_bone_id: 'Hips', label: 'Hips', raw_label: 'Hips', role: 'hips' },
        ],
        target_tracks: [
          {
            target_node_name: 'bone_5',
            target_node_index: 5,
            target_role: 'hips',
            rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }],
          },
        ],
        solver_export_contract: {
          root_motion: { status: 'emitted' },
          basis_rest_pose: { status: 'omitted', reason: 'basis/rest-pose evidence not emitted by solver export' },
          body_chains: {
            status: 'emitted',
            required: { torso: '4/5', left_arm: '3/3', right_arm: '3/3', left_leg: '3/3', right_leg: '3/3' },
          },
          hands: { left: { status: 'emitted' }, right: { status: 'emitted' } },
          fingers: { left: { status: 'omitted', reason: 'source_or_target_finger_tracks_unavailable' }, right: { status: 'omitted', reason: 'source_or_target_finger_tracks_unavailable' } },
          explicit_omissions: [{ path: 'finger_rotation', reason: 'source_or_target_finger_tracks_unavailable' }],
        },
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.deepEqual(normalized.motionRetarget?.sourceContract, {
    schema: 'modly.humanoid-promotion.v1',
    trusted: false,
    status: 'manual_confirmed',
    sidecarPayloadSha256: 'a'.repeat(64),
    sidecarWorkspacePath: 'Workflows/avatars/manual.humanoid-promotion.v1.json',
    sourceMeshWorkspacePath: 'Workflows/avatars/manual.glb',
    sourceMeshSha256: 'b'.repeat(64),
  })
  assert.deepEqual(normalized.motionRetarget?.coverage, {
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
  })
  assert.deepEqual(normalized.motionRetarget?.omittedChannels, [
    { targetNodeName: '*', channel: 'finger_rotation', reason: 'source_or_target_finger_tracks_unavailable' },
    { targetNodeName: '*', channel: 'basis_rest_pose', reason: 'basis/rest-pose evidence not emitted by solver export' },
  ])
})

test('normalizeKimodoMotionArtifact still fails closed when rotation timestamps are invalid', () => {
  const artifact = createKimodoArtifact()

  const result = expectSuccess(normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-invalid-time',
    metadataWorkspacePath: 'Workflows/kimodo/run-invalid-time/metadata.json',
    metadata: {
      runtime_status: 'success',
      clip_name: 'Invalid Timestamp',
      artifacts: ['animated.glb', 'metadata.json'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 1,
        source_contract: { schema: 'modly.humanoid-promotion.v1', trusted: true },
        mapping_status: 'manual_confirmed',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1,
        source_bones: [
          {
            source_bone_id: 'src:hips',
            label: 'Source Hips',
            raw_label: 'Hips',
          },
        ],
        target_tracks: [
          {
            target_node_name: 'bone_5',
            target_node_index: 5,
            rotations: [
              { timeSeconds: '0.0', x: 0.539, y: 0.457, z: 0.455, w: 0.541 },
            ],
          },
        ],
      },
    },
  }))

  assert.equal(result.motionRetarget?.status, 'invalid')
  assert.deepEqual(result.motionRetarget?.targetTracks, [])
  assert.match(result.motionRetarget?.diagnostics.join('\n') ?? '', /invalid quaternion rotation data/i)
})

test('normalizeKimodoMotionArtifact preserves preview fallback diagnostics from Kimodo text-to-motion-preview outputs', () => {
  const artifact = createKimodoArtifact({
    uri: '/workspace/Workflows/kimodo/run-2/preview.glb',
    legacy: { filePath: '/workspace/Workflows/kimodo/run-2/preview.glb', outputType: 'mesh' },
    provenance: {
      workflowId: 'workflow-2',
      workflowNodeId: 'preview-node',
      extensionId: 'kimodo-soma-rp',
      extensionNodeId: 'text-to-motion-preview',
    },
  })

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Workflows/kimodo/run-2',
    metadataWorkspacePath: 'Workflows/kimodo/run-2/metadata.json',
    metadata: {
      runtime_status: 'success_with_fallback',
      retarget_status: 'failed',
      animation_mapping_status: 'failed',
      retarget_error_code: 'MAPPING_INCOMPATIBLE',
      retarget_error_aliases: ['BVH_UNAVAILABLE'],
      retarget_error_message: 'Preview fallback preserved for inspection only.',
      fallback_output: 'preview.glb',
      artifacts: ['metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
      canonical_motion_artifact: 'motion.npz',
      warnings: ['visual_quality_warning'],
      diagnostics: {
        bvh_path: 'motion.bvh',
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.equal(normalized.nodeId, 'text-to-motion-preview')
  assert.equal(normalized.previewGlbWorkspacePath, 'Workflows/kimodo/run-2/preview.glb')
  assert.equal(normalized.animatedGlbWorkspacePath, undefined)
  assert.equal(normalized.diagnostics.runtimeStatus, 'success_with_fallback')
  assert.equal(normalized.diagnostics.retargetStatus, 'failed')
  assert.equal(normalized.diagnostics.retargetErrorCode, 'MAPPING_INCOMPATIBLE')
  assert.deepEqual(normalized.diagnostics.retargetErrorAliases, ['BVH_UNAVAILABLE'])
  assert.equal(normalized.motionBvhWorkspacePath, 'Workflows/kimodo/run-2/motion.bvh')
})

test('normalizeKimodoMotionArtifact rejects unsafe bundle-relative metadata paths and unsupported provenance', () => {
  const badPath = normalizeKimodoMotionArtifact({
    artifact: createKimodoArtifact(),
    bundleWorkspacePath: 'Workflows/kimodo/run-3',
    metadataWorkspacePath: 'Workflows/kimodo/run-3/metadata.json',
    metadata: {
      artifacts: ['preview.glb', '../escape.glb'],
      canonical_motion_artifact: '../motion.npz',
      warnings: [],
    },
  })

  assert.deepEqual(badPath, {
    ok: false,
    errors: [
      'Kimodo metadata path must stay workspace-relative inside the bundle: ../escape.glb',
      'Kimodo metadata path must stay workspace-relative inside the bundle: ../motion.npz',
    ],
  })

  const unsupported = normalizeKimodoMotionArtifact({
    artifact: createKimodoArtifact({
      provenance: {
        workflowId: 'workflow-3',
        workflowNodeId: 'other-node',
        extensionId: 'not-kimodo',
        extensionNodeId: 'animate-rigged-mesh',
      },
    }),
    bundleWorkspacePath: 'Workflows/kimodo/run-3',
    metadataWorkspacePath: 'Workflows/kimodo/run-3/metadata.json',
    metadata: { warnings: [] },
  })

  assert.deepEqual(unsupported, {
    ok: false,
    errors: ['Workflow artifact provenance is not a supported Kimodo motion node.'],
  })
})

test('normalizeKimodoMotionArtifact accepts sibling metadata fallback for direct-imported Kimodo animated.glb bundles without provenance', () => {
  const artifact = createKimodoArtifact({
    uri: '/workspace/Imports/kimodo/run-4/animated.glb',
    legacy: { filePath: '/workspace/Imports/kimodo/run-4/animated.glb', outputType: 'mesh' },
    provenance: undefined,
  })

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Imports/kimodo/run-4',
    metadataWorkspacePath: 'Imports/kimodo/run-4/metadata.json',
    metadata: {
      extension_id: 'kimodo-soma-rp',
      node_id: 'animate-rigged-mesh',
      contract_version: '2.0.0',
      animated_artifact: 'animated.glb',
      preview_artifact: 'preview.glb',
      canonical_motion_artifact: 'motion.npz',
      bundle_artifacts: ['animated.glb', 'preview.glb', 'motion.npz', 'metadata.json'],
      warnings: ['Root-motion correctness is deferred.'],
    },
  })

  assert.deepEqual(expectSuccess(result), {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    previewGlbWorkspacePath: 'Imports/kimodo/run-4/preview.glb',
    animatedGlbWorkspacePath: 'Imports/kimodo/run-4/animated.glb',
    bundleWorkspacePath: 'Imports/kimodo/run-4',
    metadataWorkspacePath: 'Imports/kimodo/run-4/metadata.json',
    canonicalMotionArtifactWorkspacePath: 'Imports/kimodo/run-4/motion.npz',
    motionNpzWorkspacePath: 'Imports/kimodo/run-4/motion.npz',
    diagnostics: {
      runtimeStatus: null,
      retargetStatus: null,
      solverStatus: null,
      basisStatus: null,
      rootMotionStatus: null,
      animationMappingStatus: null,
      stabilizationStatus: null,
      visualQualityStatus: null,
      sourceKind: null,
      mappingConfidence: null,
      retargetErrorCode: null,
      retargetErrorAliases: [],
      retargetErrorMessage: null,
      warnings: ['Root-motion correctness is deferred.'],
      raw: {
        extension_id: 'kimodo-soma-rp',
        node_id: 'animate-rigged-mesh',
        contract_version: '2.0.0',
        animated_artifact: 'animated.glb',
        preview_artifact: 'preview.glb',
        canonical_motion_artifact: 'motion.npz',
        bundle_artifacts: ['animated.glb', 'preview.glb', 'motion.npz', 'metadata.json'],
        warnings: ['Root-motion correctness is deferred.'],
      },
    },
  })
})

test('normalizeKimodoMotionArtifact leaves legacy bundles diagnostics-only and fails closed for invalid kimodo.motion-retarget.v1 payloads', () => {
  const legacy = expectSuccess(normalizeKimodoMotionArtifact({
    artifact: createKimodoArtifact(),
    bundleWorkspacePath: 'Workflows/kimodo/run-legacy',
    metadataWorkspacePath: 'Workflows/kimodo/run-legacy/metadata.json',
    metadata: {
      runtime_status: 'success',
      artifacts: ['animated.glb', 'metadata.json'],
    },
  }))
  assert.equal(legacy.motionRetarget, undefined)

  const invalid = expectSuccess(normalizeKimodoMotionArtifact({
    artifact: createKimodoArtifact(),
    bundleWorkspacePath: 'Workflows/kimodo/run-invalid',
    metadataWorkspacePath: 'Workflows/kimodo/run-invalid/metadata.json',
    metadata: {
      runtime_status: 'success',
      clip_name: 'Invalid Contract',
      artifacts: ['animated.glb', 'metadata.json'],
      kimodo_motion_retarget: {
        schema: 'kimodo.motion-retarget.v1',
        contract_version: 2,
        source_contract: { schema: 'modly.humanoid.v1', trusted: true },
        mapping_status: 'trusted_manual',
        mapping_confidence: 'compatible',
        fps: 30,
        duration_seconds: 1,
        source_bones: [
          {
            source_bone_id: 'src:hips',
            label: 'Source Hips',
            raw_label: 'Hips',
          },
        ],
        target_tracks: [
          {
            target_node_name: 'Hips',
            target_node_index: 0,
            rotations: [
              { time_seconds: 0, x: 0, y: 0, z: 0, w: 1 },
              { time_seconds: 0.5, x: 0, y: 0, z: 0 },
            ],
          },
        ],
      },
    },
  }))

  assert.equal(invalid.motionRetarget?.status, 'invalid')
  assert.deepEqual(invalid.motionRetarget?.sourceBones, [
    {
      sourceBoneId: 'src:hips',
      label: 'Source Hips',
      rawLabel: 'Hips',
    },
  ])
  assert.deepEqual(invalid.motionRetarget?.targetTracks, [])
  assert.match(invalid.motionRetarget?.diagnostics.join('\n') ?? '', /contract version/i)
})

test('normalizeKimodoMotionArtifact rejects sibling metadata fallback when artifact paths escape the Kimodo bundle', () => {
  const artifact = createKimodoArtifact({
    uri: '/workspace/Imports/kimodo/run-5/animated.glb',
    legacy: { filePath: '/workspace/Imports/kimodo/run-5/animated.glb', outputType: 'mesh' },
    provenance: undefined,
  })

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Imports/kimodo/run-5',
    metadataWorkspacePath: 'Imports/kimodo/run-5/metadata.json',
    metadata: {
      extension_id: 'kimodo-soma-rp',
      node_id: 'animate-rigged-mesh',
      contract_version: '2.0.0',
      animated_artifact: '/tmp/animated.glb',
      preview_artifact: 'preview.glb',
      canonical_motion_artifact: 'motion.npz',
      bundle_artifacts: ['/tmp/animated.glb', 'preview.glb', 'motion.npz', 'metadata.json'],
    },
  })

  assert.deepEqual(result, {
    ok: false,
    errors: [
      'Kimodo metadata path must stay workspace-relative inside the bundle: /tmp/animated.glb',
      'Kimodo metadata path must stay workspace-relative inside the bundle: /tmp/animated.glb',
    ],
  })
})

test('normalizeKimodoMotionArtifact prefers safe top-level motion_bvh_artifact over absolute legacy diagnostics bvh_path', () => {
  const artifact = createKimodoArtifact({
    provenance: undefined,
    uri: '/workspace/Imports/kimodo/run-6/animated.glb',
    legacy: { filePath: '/workspace/Imports/kimodo/run-6/animated.glb', outputType: 'mesh' },
  })

  const result = normalizeKimodoMotionArtifact({
    artifact,
    bundleWorkspacePath: 'Imports/kimodo/run-6',
    metadataWorkspacePath: 'Imports/kimodo/run-6/metadata.json',
    metadata: {
      extension_id: 'kimodo-soma-rp',
      node_id: 'animate-rigged-mesh',
      contract_version: '2.0.0',
      animated_artifact: 'animated.glb',
      preview_artifact: 'preview.glb',
      canonical_motion_artifact: 'motion.npz',
      motion_bvh_artifact: 'motion.bvh',
      bundle_artifacts: ['animated.glb', 'preview.glb', 'motion.npz', 'motion.bvh', 'metadata.json'],
      diagnostics: {
        bvh_path: '/home/drhepa/shiro-stack/repos/Tools/modly/tmp/kimodo/run-6/motion.bvh',
      },
    },
  })

  const normalized = expectSuccess(result)
  assert.equal(normalized.motionBvhWorkspacePath, 'Imports/kimodo/run-6/motion.bvh')
  assert.deepEqual(normalized.diagnostics.raw, {
    extension_id: 'kimodo-soma-rp',
    node_id: 'animate-rigged-mesh',
    contract_version: '2.0.0',
    animated_artifact: 'animated.glb',
    preview_artifact: 'preview.glb',
    canonical_motion_artifact: 'motion.npz',
    motion_bvh_artifact: 'motion.bvh',
    bundle_artifacts: ['animated.glb', 'preview.glb', 'motion.npz', 'motion.bvh', 'metadata.json'],
    diagnostics: {
      bvh_path: '/home/drhepa/shiro-stack/repos/Tools/modly/tmp/kimodo/run-6/motion.bvh',
    },
  })
})

test('normalizeKimodoMotionArtifact still rejects unsafe top-level motion_bvh_artifact paths', () => {
  const result = normalizeKimodoMotionArtifact({
    artifact: createKimodoArtifact(),
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    metadata: {
      animated_artifact: 'animated.glb',
      preview_artifact: 'preview.glb',
      canonical_motion_artifact: 'motion.npz',
      motion_bvh_artifact: '/tmp/motion.bvh',
      bundle_artifacts: ['animated.glb', 'preview.glb', 'motion.npz', 'metadata.json'],
    },
  })

  assert.deepEqual(result, {
    ok: false,
    errors: ['Kimodo metadata path must stay workspace-relative inside the bundle: /tmp/motion.bvh'],
  })
})
