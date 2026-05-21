import * as THREE from 'three'

import { isPoseClipQuaternion, type PoseClipKeyframe, type PoseClipPlan, type PoseClipQuaternion } from './poseClipPlan.ts'
import type { RigBoneId, RigSkeletonSummary } from './rigSkeleton.ts'

export type PoseClipBoneMap = Map<RigBoneId, THREE.Bone>
export type PoseClipQuaternionSnapshot = Map<RigBoneId, THREE.Quaternion>
export type PoseClipRotationAxis = 'x' | 'y' | 'z'

export interface ApplyLocalPoseClipRotationInput {
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  boneId: RigBoneId
  axis: PoseClipRotationAxis
  degreesDelta: number
}

export interface ApplyLocalPoseClipRotationResult {
  applied: boolean
  boneId: RigBoneId
  rotation: PoseClipQuaternion | null
  warning?: string
}

export interface ResetPoseClipSelectedBoneInput {
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>
  boneId: RigBoneId
}

export interface ResetPoseClipSelectedBoneResult {
  restoredBoneIds: RigBoneId[]
  warnings: string[]
}

export interface PoseClipBoneLookupResult {
  bonesById: PoseClipBoneMap
  missingBoneIds: RigBoneId[]
  warnings: string[]
}

export interface EvaluatePoseClipPreviewInput {
  plan: PoseClipPlan
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  timeSeconds: number
}

export interface EvaluatePoseClipPreviewResult {
  timeSeconds: number
  appliedBoneIds: RigBoneId[]
  missingBoneIds: RigBoneId[]
  warnings: string[]
}

export interface ResetPoseClipPreviewInput {
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>
}

export interface ResetPoseClipPreviewResult {
  timeSeconds: 0
  restoredBoneIds: RigBoneId[]
  warnings: string[]
}

export interface RestoreThenEvaluatePoseClipPreviewInput extends EvaluatePoseClipPreviewInput {
  snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>
}

export interface RestoreThenEvaluatePoseClipPreviewResult {
  restoredBoneIds: RigBoneId[]
  preview: EvaluatePoseClipPreviewResult
}

export interface PoseClipPreviewSource {
  scene: THREE.Object3D
  sourceWorkspacePath: string
  skeletonContextId: string
}

export interface PoseClipPreviewSession {
  readonly source: Readonly<PoseClipPreviewSource>
  readonly bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  readonly snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>
}

/** Capture the initiating objects. A same-URL replacement must get a new session. */
export function createPoseClipPreviewSession(
  source: PoseClipPreviewSource,
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>,
): PoseClipPreviewSession {
  const capturedBones = new Map(bonesById)
  return { source: { ...source }, bonesById: capturedBones, snapshot: takePoseClipQuaternionSnapshot(capturedBones) }
}

export function restorePoseClipPreviewSession(session: PoseClipPreviewSession): RigBoneId[] {
  return restorePoseClipQuaternionSnapshot(session.bonesById, session.snapshot)
}

export function evaluatePoseClipPreviewSession(
  session: PoseClipPreviewSession,
  source: PoseClipPreviewSource,
  plan: PoseClipPlan,
  timeSeconds: number,
): EvaluatePoseClipPreviewResult {
  if (session.source.scene !== source.scene || session.source.sourceWorkspacePath !== source.sourceWorkspacePath
    || session.source.skeletonContextId !== source.skeletonContextId || plan.skeletonContextId !== source.skeletonContextId) {
    return { timeSeconds: 0, appliedBoneIds: [], missingBoneIds: [], warnings: ['Pose preview source or skeleton context changed.'] }
  }
  // Restore every captured target, including bones whose final key was deleted.
  restorePoseClipPreviewSession(session)
  return evaluatePoseClipPreview({ plan, bonesById: session.bonesById, timeSeconds })
}

export function buildPoseClipBoneLookup(
  summary: RigSkeletonSummary,
  currentBonesById: Readonly<Record<RigBoneId, THREE.Bone> | Map<RigBoneId, THREE.Bone>>,
): PoseClipBoneLookupResult {
  const current = toReadonlyBoneMap(currentBonesById)
  const expectedBoneIds = new Set(summary.bones.map((bone) => bone.boneId))
  const bonesById: PoseClipBoneMap = new Map()
  const missingBoneIds: RigBoneId[] = []
  const warnings: string[] = []

  for (const bone of summary.bones) {
    const currentBone = current.get(bone.boneId)
    if (currentBone) {
      bonesById.set(bone.boneId, currentBone)
      continue
    }
    missingBoneIds.push(bone.boneId)
    warnings.push(`Missing THREE.Bone for RigBoneId "${bone.boneId}"; pose preview will skip this target.`)
  }

  for (const boneId of current.keys()) {
    if (!expectedBoneIds.has(boneId)) {
      warnings.push(`Ignoring THREE.Bone for unknown RigBoneId "${boneId}"; it will not be rebound by label or index.`)
    }
  }

  return { bonesById, missingBoneIds, warnings }
}

export function takePoseClipQuaternionSnapshot(bonesById: ReadonlyMap<RigBoneId, THREE.Bone>): PoseClipQuaternionSnapshot {
  const snapshot: PoseClipQuaternionSnapshot = new Map()
  for (const [boneId, bone] of bonesById) {
    snapshot.set(boneId, bone.quaternion.clone())
  }
  return snapshot
}

export function restorePoseClipQuaternionSnapshot(
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>,
  snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>,
): RigBoneId[] {
  const restoredBoneIds: RigBoneId[] = []
  for (const [boneId, quaternion] of snapshot) {
    const bone = bonesById.get(boneId)
    if (!bone) continue
    bone.quaternion.copy(quaternion)
    restoredBoneIds.push(boneId)
  }
  return restoredBoneIds
}

export function applyLocalPoseClipRotation(input: ApplyLocalPoseClipRotationInput): ApplyLocalPoseClipRotationResult {
  const bone = input.bonesById.get(input.boneId)
  if (!bone) {
    return {
      applied: false,
      boneId: input.boneId,
      rotation: null,
      warning: `Cannot rotate missing RigBoneId "${input.boneId}".`,
    }
  }

  if (!Number.isFinite(input.degreesDelta) || !isPoseClipQuaternion(bone.quaternion)) {
    return { applied: false, boneId: input.boneId, rotation: null, warning: 'Pose rotation requires finite input and a nonzero quaternion.' }
  }
  const degreesDelta = input.degreesDelta % 360
  const axis = axisVector(input.axis)
  const delta = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degreesDelta)).normalize()
  bone.quaternion.multiply(delta).normalize()

  return { applied: true, boneId: input.boneId, rotation: toPoseClipQuaternion(bone.quaternion) }
}

export function readPoseClipBoneQuaternion(
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>,
  boneId: RigBoneId,
): PoseClipQuaternion | null {
  const bone = bonesById.get(boneId)
  return bone ? toPoseClipQuaternion(bone.quaternion) : null
}

export function resetPoseClipSelectedBone(input: ResetPoseClipSelectedBoneInput): ResetPoseClipSelectedBoneResult {
  const bone = input.bonesById.get(input.boneId)
  if (!bone) {
    return { restoredBoneIds: [], warnings: [`Cannot reset missing RigBoneId "${input.boneId}".`] }
  }
  const snapshotQuaternion = input.snapshot.get(input.boneId)
  if (!snapshotQuaternion) {
    return { restoredBoneIds: [], warnings: [`Cannot reset RigBoneId "${input.boneId}" because no pose snapshot exists.`] }
  }
  bone.quaternion.copy(snapshotQuaternion)
  return { restoredBoneIds: [input.boneId], warnings: [] }
}

export function evaluatePoseClipPreview(input: EvaluatePoseClipPreviewInput): EvaluatePoseClipPreviewResult {
  const timeSeconds = clampPreviewTime(input.timeSeconds, input.plan.clip.durationSeconds)
  const validKeyframes = input.plan.keyframes.filter((keyframe) => Number.isFinite(keyframe.timeSeconds) && isPoseClipQuaternion(keyframe.rotation))
  const tracks = groupKeyframesByBoneId(validKeyframes)
  const appliedBoneIds: RigBoneId[] = []
  const missingBoneIds: RigBoneId[] = []
  const warnings: string[] = validKeyframes.length === input.plan.keyframes.length ? [] : ['Invalid pose keyframes were skipped; preview supports rotation only.']

  for (const [boneId, keyframes] of tracks) {
    const bone = input.bonesById.get(boneId)
    if (!bone) {
      missingBoneIds.push(boneId)
      warnings.push(`Skipping pose preview keyframes for missing RigBoneId "${boneId}".`)
      continue
    }

    bone.quaternion.copy(evaluateQuaternionTrack(keyframes, timeSeconds))
    appliedBoneIds.push(boneId)
  }

  return { timeSeconds, appliedBoneIds, missingBoneIds, warnings }
}

export function resetPoseClipPreview(input: ResetPoseClipPreviewInput): ResetPoseClipPreviewResult {
  return {
    timeSeconds: 0,
    restoredBoneIds: restorePoseClipQuaternionSnapshot(input.bonesById, input.snapshot),
    warnings: [],
  }
}

export function restoreThenEvaluatePoseClipPreview(input: RestoreThenEvaluatePoseClipPreviewInput): RestoreThenEvaluatePoseClipPreviewResult {
  const restoredBoneIds = restorePoseClipQuaternionSnapshot(input.bonesById, input.snapshot)
  const preview = evaluatePoseClipPreview({
    plan: input.plan,
    bonesById: input.bonesById,
    timeSeconds: input.timeSeconds,
  })
  return { restoredBoneIds, preview }
}

function toReadonlyBoneMap(currentBonesById: Readonly<Record<RigBoneId, THREE.Bone> | Map<RigBoneId, THREE.Bone>>): ReadonlyMap<RigBoneId, THREE.Bone> {
  if (currentBonesById instanceof Map) return currentBonesById
  return new Map(Object.entries(currentBonesById))
}

function groupKeyframesByBoneId(keyframes: readonly PoseClipKeyframe[]): Map<RigBoneId, PoseClipKeyframe[]> {
  const tracks = new Map<RigBoneId, PoseClipKeyframe[]>()
  for (const keyframe of keyframes) {
    const existingTrack = tracks.get(keyframe.boneId)
    if (existingTrack) {
      existingTrack.push(cloneKeyframe(keyframe))
      continue
    }
    tracks.set(keyframe.boneId, [cloneKeyframe(keyframe)])
  }
  for (const [boneId, track] of tracks) {
    tracks.set(boneId, track.sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id)))
  }
  return tracks
}

function evaluateQuaternionTrack(keyframes: readonly PoseClipKeyframe[], timeSeconds: number): THREE.Quaternion {
  if (keyframes.length === 0) return new THREE.Quaternion()
  if (timeSeconds <= keyframes[0].timeSeconds) return toThreeQuaternion(keyframes[0].rotation)
  const last = keyframes[keyframes.length - 1]
  if (timeSeconds >= last.timeSeconds) return toThreeQuaternion(last.rotation)

  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index]
    const to = keyframes[index + 1]
    if (timeSeconds < from.timeSeconds || timeSeconds > to.timeSeconds) continue
    const span = to.timeSeconds - from.timeSeconds
    const alpha = span <= 0 ? 0 : (timeSeconds - from.timeSeconds) / span
    return new THREE.Quaternion().slerpQuaternions(toThreeQuaternion(from.rotation), toThreeQuaternion(to.rotation), alpha).normalize()
  }

  return toThreeQuaternion(last.rotation)
}

function toThreeQuaternion(rotation: PoseClipQuaternion): THREE.Quaternion {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w)
  return new THREE.Quaternion(rotation.x / length, rotation.y / length, rotation.z / length, rotation.w / length)
}

function toPoseClipQuaternion(quaternion: THREE.Quaternion): PoseClipQuaternion {
  const normalized = quaternion.clone().normalize()
  return { x: normalized.x, y: normalized.y, z: normalized.z, w: normalized.w }
}

function axisVector(axis: PoseClipRotationAxis): THREE.Vector3 {
  if (axis === 'y') return new THREE.Vector3(0, 1, 0)
  if (axis === 'z') return new THREE.Vector3(0, 0, 1)
  return new THREE.Vector3(1, 0, 0)
}

function cloneKeyframe(keyframe: PoseClipKeyframe): PoseClipKeyframe {
  return {
    id: keyframe.id,
    timeSeconds: keyframe.timeSeconds,
    boneId: keyframe.boneId,
    rotation: { ...keyframe.rotation },
    ...(keyframe.translation ? { translation: { ...keyframe.translation } } : {}),
    ...(keyframe.scale ? { scale: { ...keyframe.scale } } : {}),
  }
}

function clampPreviewTime(value: number, durationSeconds: number): number {
  if (!Number.isFinite(value)) return 0
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return Math.max(value, 0)
  return Math.min(Math.max(value, 0), durationSeconds)
}
