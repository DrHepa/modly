import * as THREE from 'three'

import { deriveKimodoPoseClipCompanionV1, type KimodoManualMappingEntry, type KimodoManualMappingSourceBone, type PoseClipPlan } from './poseClipPlan.ts'
import {
  evaluatePoseClipPreview,
  type EvaluatePoseClipPreviewResult,
} from './poseClipPreview.ts'
import type { KimodoMotionArtifact } from './kimodoMotionAdapter.ts'
import type { MotionRetargetCorrectionsV1 } from './motionRetargetPlan.ts'
import type { RigBoneId, RigSkeletonSummary } from './rigSkeleton.ts'

const BASIS_REST_POSE_PREVIEW_DISABLED_WARNING = 'Local rotation preview disabled because Kimodo omitted basis/rest-pose evidence; use animated GLB playback or export sidecar for rerun.'
const INVALID_BASIS_PREVIEW_DISABLED_WARNING = 'Local rotation preview disabled because Kimodo marked the retarget basis invalid; use animated GLB playback or export sidecar for rerun.'

export interface MotionRetargetTransformSnapshotEntry {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}

export type MotionRetargetTransformSnapshot = Map<RigBoneId, MotionRetargetTransformSnapshotEntry>

export interface MotionRetargetPreviewClipResolution {
  available: boolean
  warnings: string[]
  plan?: PoseClipPlan
}

export function resolveMotionRetargetPreviewClip(args: {
  summary: RigSkeletonSummary
  artifact: KimodoMotionArtifact
  sourceBones?: readonly KimodoManualMappingSourceBone[]
  mappings?: Readonly<Record<string, KimodoManualMappingEntry>>
}): MotionRetargetPreviewClipResolution {
  const safetyWarnings = resolveMotionRetargetPreviewSafetyWarnings(args.artifact)
  if (safetyWarnings.length > 0) return { available: false, warnings: safetyWarnings }

  const derivation = deriveKimodoPoseClipCompanionV1({
    summary: args.summary,
    artifact: args.artifact,
    sourceBones: args.sourceBones,
    mappings: args.mappings,
  })
  if (!derivation.available || !derivation.sidecar) {
    return { available: false, warnings: [...derivation.warnings] }
  }

  return {
    available: true,
    warnings: [],
    plan: {
      skeletonContextId: args.summary.skeletonContextId,
      clip: { ...derivation.sidecar.clip },
      keyframes: derivation.sidecar.keyframes.map((keyframe) => ({
        id: keyframe.id,
        timeSeconds: keyframe.timeSeconds,
        boneId: keyframe.boneId,
        rotation: { ...keyframe.rotation },
      })),
    },
  }
}

function resolveMotionRetargetPreviewSafetyWarnings(artifact: KimodoMotionArtifact): string[] {
  const omittedChannels = artifact.motionRetarget?.status === 'parsed' ? artifact.motionRetarget.omittedChannels ?? [] : []
  const warnings: string[] = []
  if (omittedChannels.some((omitted) => /basis[_\/-]?rest[_\/-]?pose/i.test(omitted.channel))) {
    warnings.push(BASIS_REST_POSE_PREVIEW_DISABLED_WARNING)
  }
  if (hasInvalidKimodoBasisContract(artifact)) warnings.push(INVALID_BASIS_PREVIEW_DISABLED_WARNING)
  return dedupeStrings(warnings)
}

function hasInvalidKimodoBasisContract(artifact: KimodoMotionArtifact): boolean {
  const basisStatus = artifact.diagnostics.basisStatus?.toLowerCase()
  if (basisStatus === 'invalid') return true
  const diagnosticsText = [
    ...artifact.diagnostics.warnings,
    artifact.diagnostics.retargetErrorCode ?? undefined,
    artifact.diagnostics.retargetErrorMessage ?? undefined,
  ].filter((value): value is string => Boolean(value)).join('\n')
  return /basis_corrected_rotation_channels_skipped_invalid_basis|basis\/invalid_forward_axis|basis\/invalid_up_axis|basis\/correction_ineligible_invalid_axes/i.test(diagnosticsText)
}

function dedupeStrings(values: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export function takeMotionRetargetPreviewSnapshot(bonesById: ReadonlyMap<RigBoneId, THREE.Bone>): MotionRetargetTransformSnapshot {
  const snapshot: MotionRetargetTransformSnapshot = new Map()
  for (const [boneId, bone] of bonesById) {
    snapshot.set(boneId, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
    })
  }
  return snapshot
}

export function evaluateMotionRetargetPreview(args: {
  plan: PoseClipPlan
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  timeSeconds: number
  summary?: RigSkeletonSummary
  snapshot?: ReadonlyMap<RigBoneId, MotionRetargetTransformSnapshotEntry>
  corrections?: MotionRetargetCorrectionsV1
}): EvaluatePoseClipPreviewResult {
  const preview = evaluatePoseClipPreview(args)
  if (args.summary && args.snapshot && args.corrections) {
    applyMotionRetargetPreviewCorrections({
      summary: args.summary,
      bonesById: args.bonesById,
      snapshot: args.snapshot,
      corrections: args.corrections,
    })
  }
  return preview
}

export function applyMotionRetargetPreviewCorrections(args: {
  summary: RigSkeletonSummary
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, MotionRetargetTransformSnapshotEntry>
  corrections: MotionRetargetCorrectionsV1
}): { appliedRootBoneIds: RigBoneId[]; previewMode: MotionRetargetCorrectionsV1['previewMode'] } {
  const appliedRootBoneIds: RigBoneId[] = []
  for (const rootBoneId of args.summary.rootBoneIds) {
    const bone = args.bonesById.get(rootBoneId)
    const original = args.snapshot.get(rootBoneId)
    if (!bone || !original) continue
    bone.position.copy(original.position)
    if (args.corrections.previewMode === 'before') continue
    if (args.corrections.rootTranslationPolicy === 'in_place') {
      bone.position.set(0, original.position.y, 0)
    } else if (args.corrections.rootTranslationPolicy === 'preserve_scaled_npz') {
      bone.position.set(
        original.position.x * args.corrections.rootMotionScale,
        original.position.y * args.corrections.rootMotionScale,
        original.position.z * args.corrections.rootMotionScale,
      )
    }
    bone.position.add(new THREE.Vector3(args.corrections.rootOffset.x, args.corrections.rootOffset.y, args.corrections.rootOffset.z))
    appliedRootBoneIds.push(rootBoneId)
  }
  return { appliedRootBoneIds, previewMode: args.corrections.previewMode }
}

export function resetMotionRetargetPreview(args: {
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, MotionRetargetTransformSnapshotEntry>
}) {
  const restoredBoneIds: RigBoneId[] = []
  for (const [boneId, transform] of args.snapshot) {
    const bone = args.bonesById.get(boneId)
    if (!bone) continue
    bone.position.copy(transform.position)
    bone.quaternion.copy(transform.quaternion)
    bone.scale.copy(transform.scale)
    restoredBoneIds.push(boneId)
  }
  return { restoredBoneIds, timeSeconds: 0 as const }
}

export function restoreThenEvaluateMotionRetargetPreview(args: {
  plan: PoseClipPlan
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, MotionRetargetTransformSnapshotEntry>
  timeSeconds: number
  summary?: RigSkeletonSummary
  corrections?: MotionRetargetCorrectionsV1
}) {
  const restored = resetMotionRetargetPreview({ bonesById: args.bonesById, snapshot: args.snapshot })
  const preview = evaluateMotionRetargetPreview({ plan: args.plan, bonesById: args.bonesById, timeSeconds: args.timeSeconds, summary: args.summary, snapshot: args.snapshot, corrections: args.corrections })
  return { restoredBoneIds: restored.restoredBoneIds, preview }
}
