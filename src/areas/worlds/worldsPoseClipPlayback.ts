import * as THREE from 'three'

import type { PoseClipRigBoneId, PoseClipSidecarV1 } from '../../shared/types/electron.d.ts'

export type WorldsPoseClipBoneSnapshot = Map<PoseClipRigBoneId, {
  quaternion: THREE.Quaternion
  position: THREE.Vector3
  scale: THREE.Vector3
}>

export interface WorldsPoseClipSampleResult {
  timeSeconds: number
  appliedBoneIds: PoseClipRigBoneId[]
  missingBoneIds: PoseClipRigBoneId[]
}

type PoseClipKeyframe = PoseClipSidecarV1['keyframes'][number]

export function createWorldsPoseClipBoneMap(root: THREE.Object3D, sidecar: PoseClipSidecarV1): Map<PoseClipRigBoneId, THREE.Bone> {
  const bones: THREE.Bone[] = []
  root.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object)
  })

  const byPath = new Map<string, THREE.Bone>()
  const byName = new Map<string, THREE.Bone | null>()
  for (const bone of bones) {
    byPath.set(createBonePath(bone).join('/'), bone)
    const current = byName.get(bone.name)
    byName.set(bone.name, current === undefined ? bone : null)
  }

  const result = new Map<PoseClipRigBoneId, THREE.Bone>()
  for (const bone of sidecar.skeleton.bones) {
    const pathMatch = byPath.get(bone.path.join('/'))
    const uniqueNameMatch = byName.get(bone.originalName) ?? byName.get(bone.label)
    const match = pathMatch ?? uniqueNameMatch ?? null
    if (match) result.set(bone.boneId, match)
  }
  return result
}

export function takeWorldsPoseClipSnapshot(bonesById: ReadonlyMap<PoseClipRigBoneId, THREE.Bone>): WorldsPoseClipBoneSnapshot {
  const snapshot: WorldsPoseClipBoneSnapshot = new Map()
  for (const [boneId, bone] of bonesById) {
    snapshot.set(boneId, {
      quaternion: bone.quaternion.clone(),
      position: bone.position.clone(),
      scale: bone.scale.clone(),
    })
  }
  return snapshot
}

export function applyWorldsPoseClipAtTime(input: {
  sidecar: PoseClipSidecarV1
  bonesById: ReadonlyMap<PoseClipRigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<PoseClipRigBoneId, { quaternion: THREE.Quaternion; position: THREE.Vector3; scale: THREE.Vector3 }>
  timeSeconds: number
}): WorldsPoseClipSampleResult {
  const timeSeconds = loopPoseClipTime(input.timeSeconds, input.sidecar.clip.durationSeconds)
  const tracks = groupKeyframesByBoneId(input.sidecar.keyframes)
  const appliedBoneIds: PoseClipRigBoneId[] = []
  const missingBoneIds: PoseClipRigBoneId[] = []

  for (const [boneId, keyframes] of tracks) {
    const bone = input.bonesById.get(boneId)
    const base = input.snapshot.get(boneId)
    if (!bone || !base) {
      missingBoneIds.push(boneId)
      continue
    }

    const sample = evaluatePoseClipTrack(keyframes, timeSeconds)
    bone.quaternion.copy(sample.quaternion)
    bone.position.copy(sample.position ?? base.position)
    bone.scale.copy(sample.scale ?? base.scale)
    appliedBoneIds.push(boneId)
  }

  return { timeSeconds, appliedBoneIds, missingBoneIds }
}

export function loopPoseClipTime(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) return 0
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return Math.max(timeSeconds, 0)
  return ((timeSeconds % durationSeconds) + durationSeconds) % durationSeconds
}

function evaluatePoseClipTrack(keyframes: readonly PoseClipKeyframe[], timeSeconds: number): { quaternion: THREE.Quaternion; position?: THREE.Vector3; scale?: THREE.Vector3 } {
  if (keyframes.length === 0) return { quaternion: new THREE.Quaternion() }
  if (timeSeconds <= keyframes[0].timeSeconds) return toSample(keyframes[0])
  const last = keyframes[keyframes.length - 1]
  if (timeSeconds >= last.timeSeconds) return toSample(last)

  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index]
    const to = keyframes[index + 1]
    if (timeSeconds < from.timeSeconds || timeSeconds > to.timeSeconds) continue
    const span = to.timeSeconds - from.timeSeconds
    const alpha = span <= 0 ? 0 : (timeSeconds - from.timeSeconds) / span
    return {
      quaternion: new THREE.Quaternion().slerpQuaternions(toQuaternion(from), toQuaternion(to), alpha).normalize(),
      position: from.translation && to.translation ? toVector3(from.translation).lerp(toVector3(to.translation), alpha) : undefined,
      scale: from.scale && to.scale ? toVector3(from.scale).lerp(toVector3(to.scale), alpha) : undefined,
    }
  }

  return toSample(last)
}

function groupKeyframesByBoneId(keyframes: readonly PoseClipKeyframe[]): Map<PoseClipRigBoneId, PoseClipKeyframe[]> {
  const tracks = new Map<PoseClipRigBoneId, PoseClipKeyframe[]>()
  for (const keyframe of keyframes) {
    const track = tracks.get(keyframe.boneId)
    if (track) track.push(keyframe)
    else tracks.set(keyframe.boneId, [keyframe])
  }
  for (const [boneId, track] of tracks) {
    tracks.set(boneId, [...track].sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id)))
  }
  return tracks
}

function toSample(keyframe: PoseClipKeyframe): { quaternion: THREE.Quaternion; position?: THREE.Vector3; scale?: THREE.Vector3 } {
  return {
    quaternion: toQuaternion(keyframe),
    ...(keyframe.translation ? { position: toVector3(keyframe.translation) } : {}),
    ...(keyframe.scale ? { scale: toVector3(keyframe.scale) } : {}),
  }
}

function toQuaternion(keyframe: PoseClipKeyframe): THREE.Quaternion {
  const rotation = keyframe.rotation
  return new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).normalize()
}

function toVector3(value: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z)
}

function createBonePath(bone: THREE.Bone): string[] {
  const path: string[] = []
  let current: THREE.Object3D | null = bone
  while (current) {
    if (current instanceof THREE.Bone) path.unshift(current.name)
    current = current.parent
  }
  return path
}
