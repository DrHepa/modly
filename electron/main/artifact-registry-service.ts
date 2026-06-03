import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path'

import type { ArtifactRegistryReadResult, ArtifactRegistryWriteResult, ArtifactSidecar, EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult, LandmarkSidecarWriteRequest, LandmarkSidecarWriteResult, RigMetaSidecarReadResult, RigRenameSidecarV1, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult } from '../../src/shared/types/electron.d'

const SIDECAR_SUFFIX = '.artifact.json'
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const LANDMARK_SIDECAR_PREFIX = 'Workflows/landmarks/'
const LANDMARK_SIDECAR_SUFFIX = '.landmarks.v1.json'
const RIG_RENAME_SIDECAR_PREFIX = 'Workflows/rig-edits/'
const RIG_RENAME_SIDECAR_SUFFIX = '.rig.v1.json'
const POSE_CLIP_SIDECAR_PREFIX = 'Workflows/pose-clips/'
const POSE_CLIP_SIDECAR_SUFFIX = '.pose-clip.v1.json'
const RIGMETA_MESH_EXTENSION_PATTERN = /\.(glb|gltf)$/i
const SUPPORTED_RIGMETA_SCHEMA_VALUES = new Set([
  'modly.rigmeta',
  'modly.unirig.rigmeta',
  'unirig.rigmeta',
])
const REQUIRED_LANDMARK_IDS = ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'] as const
const REQUIRED_LANDMARK_ID_SET = new Set<string>(REQUIRED_LANDMARK_IDS)

export interface NormalizedWorkspaceArtifactPath {
  workspacePath: string
  absolutePath: string
}

export interface ArtifactRegistryReadRequest {
  workspaceDir: string
  workspacePath: string
}

export interface ArtifactRegistryWriteRequest extends ArtifactRegistryReadRequest {
  artifactId: string
  metadata: Record<string, unknown>
}

export interface EditedSceneArtifactWriteServiceRequest extends EditedSceneArtifactWriteRequest {
  workspaceDir: string
}

export interface LandmarkSidecarWriteServiceRequest extends Omit<LandmarkSidecarWriteRequest, 'sidecar'> {
  workspaceDir: string
  sidecar: unknown
}

export interface RigRenameSidecarWriteServiceRequest extends Omit<RigRenameSidecarWriteRequest, 'sidecar'> {
  workspaceDir: string
  sidecar: unknown
}

export interface RigRenameSidecarReadServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}

export interface PoseClipSidecarWriteServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: unknown
}

export interface PoseClipSidecarReadServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  legacySidecarWorkspacePath?: string
  sourceWorkspacePath: string
}

export interface RigMetaSidecarReadServiceRequest {
  workspaceDir: string
  sourceWorkspacePath: string
}

export type RigRenameSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: RigRenameSidecarV1
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: false
      status: 'invalid' | 'error'
      error: string
    }

export type PoseClipSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: unknown
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: false
      status: 'invalid' | 'error'
      error: string
    }

export type PoseClipSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: unknown
    }
  | {
      success: false
      error: string
    }

export interface ArtifactRegistryIpcMainLike {
  handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void
}

export interface ArtifactRegistryIpcRegistrationDeps {
  ipcMain: ArtifactRegistryIpcMainLike
  getWorkspaceDir: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWindowsAbsolutePath(candidate: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(candidate) || candidate.startsWith('\\\\')
}

function normalizeWorkspaceSeparators(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/')
}

function assertSafeWorkspacePathInput(workspacePath: string): string {
  const normalized = normalizeWorkspaceSeparators(workspacePath.trim())
  if (!normalized || normalized === '.') {
    throw new Error('Artifact workspace path must be workspace-relative and non-empty')
  }
  if (isAbsolute(normalized) || isWindowsAbsolutePath(workspacePath)) {
    throw new Error('Artifact workspace path must not be absolute')
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Artifact workspace path must not contain traversal segments')
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/')
}

export function normalizeWorkspaceArtifactPath(workspaceDir: string, workspacePath: string): NormalizedWorkspaceArtifactPath {
  const safeWorkspacePath = assertSafeWorkspacePathInput(workspacePath)
  const resolvedWorkspace = resolvePath(workspaceDir)
  const absolutePath = resolvePath(resolvedWorkspace, ...safeWorkspacePath.split('/'))
  const relativePath = normalizeWorkspaceSeparators(relative(resolvedWorkspace, absolutePath))

  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('Artifact workspace path escapes the configured workspace')
  }

  return {
    workspacePath: safeWorkspacePath,
    absolutePath,
  }
}

export function getArtifactSidecarWorkspacePath(workspacePath: string): string {
  return `${normalizeWorkspaceSeparators(workspacePath)}${SIDECAR_SUFFIX}`
}

function resolveSidecarPath(workspaceDir: string, workspacePath: string): NormalizedWorkspaceArtifactPath {
  const assetPath = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath)
  return normalizeWorkspaceArtifactPath(workspaceDir, getArtifactSidecarWorkspacePath(assetPath.workspacePath))
}

function parseReadPayload(payload: unknown, workspaceDir: string): ArtifactRegistryReadRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string') {
    throw new Error('Artifact registry read requires a workspacePath string')
  }
  return { workspaceDir, workspacePath: payload.workspacePath }
}

function parseWritePayload(payload: unknown, workspaceDir: string): ArtifactRegistryWriteRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string' || typeof payload.artifactId !== 'string' || !isRecord(payload.metadata)) {
    throw new Error('Artifact registry write requires workspacePath, artifactId, and metadata')
  }
  return {
    workspaceDir,
    workspacePath: payload.workspacePath,
    artifactId: payload.artifactId,
    metadata: payload.metadata,
  }
}

function isBytesLike(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof ArrayBuffer || value instanceof Uint8Array
}

function parseEditedSceneArtifactPayload(payload: unknown, workspaceDir: string): EditedSceneArtifactWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.glbWorkspacePath !== 'string'
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isBytesLike(payload.bytes)
    || !isRecord(payload.metadata)
  ) {
    throw new Error('Edited scene artifact write requires glbWorkspacePath, sidecarWorkspacePath, sourceWorkspacePath, bytes, and metadata')
  }

  return {
    workspaceDir,
    glbWorkspacePath: payload.glbWorkspacePath,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    bytes: payload.bytes,
    metadata: payload.metadata,
  }
}

function parseLandmarkSidecarPayload(payload: unknown, workspaceDir: string): LandmarkSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Landmark sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parseRigRenameSidecarPayload(payload: unknown, workspaceDir: string): RigRenameSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Rig rename sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parseRigRenameSidecarReadPayload(payload: unknown, workspaceDir: string): RigRenameSidecarReadServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
  ) {
    throw new Error('Rig rename sidecar read requires sidecarWorkspacePath and sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function parsePoseClipSidecarPayload(payload: unknown, workspaceDir: string): PoseClipSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Pose clip sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parsePoseClipSidecarReadPayload(payload: unknown, workspaceDir: string): PoseClipSidecarReadServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
  ) {
    throw new Error('Pose clip sidecar read requires sidecarWorkspacePath and sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    legacySidecarWorkspacePath: typeof payload.legacySidecarWorkspacePath === 'string' ? payload.legacySidecarWorkspacePath : undefined,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function parseRigMetaSidecarReadPayload(payload: unknown, workspaceDir: string): RigMetaSidecarReadServiceRequest {
  if (!isRecord(payload) || typeof payload.sourceWorkspacePath !== 'string') {
    throw new Error('Rigmeta sidecar read requires sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function toByteBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  return bytes instanceof Uint8Array
    ? Buffer.from(bytes)
    : Buffer.from(new Uint8Array(bytes))
}

function assertEditedArtifactPathExtensions(glbWorkspacePath: string, sidecarWorkspacePath: string): void {
  if (!glbWorkspacePath.endsWith('.glb')) {
    throw new Error('Edited scene artifact GLB path must end with .glb')
  }
  if (!sidecarWorkspacePath.endsWith('.json')) {
    throw new Error('Edited scene artifact sidecar path must end with .json')
  }
}

function assertEditedArtifactPrefix(glbWorkspacePath: string, sidecarWorkspacePath: string): void {
  if (!glbWorkspacePath.startsWith('Workflows/edited/') || !sidecarWorkspacePath.startsWith('Workflows/edited/')) {
    throw new Error('Edited scene artifact paths must stay under Workflows/edited/')
  }
}

function assertLandmarkSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(LANDMARK_SIDECAR_PREFIX)) {
    throw new Error('Landmark sidecar path must stay under Workflows/landmarks/')
  }
  if (!sidecarWorkspacePath.endsWith(LANDMARK_SIDECAR_SUFFIX)) {
    throw new Error('Landmark sidecar path must end with .landmarks.v1.json')
  }
}

function assertRigRenameSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(RIG_RENAME_SIDECAR_PREFIX)) {
    throw new Error('Rig rename sidecar path must stay under Workflows/rig-edits/')
  }
  if (!sidecarWorkspacePath.endsWith(RIG_RENAME_SIDECAR_SUFFIX)) {
    throw new Error('Rig rename sidecar path must end with .rig.v1.json')
  }
}

function assertPoseClipSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(POSE_CLIP_SIDECAR_PREFIX)) {
    throw new Error('Pose clip sidecar path must stay under Workflows/pose-clips/')
  }
  if (!sidecarWorkspacePath.endsWith(POSE_CLIP_SIDECAR_SUFFIX)) {
    throw new Error('Pose clip sidecar path must end with .pose-clip.v1.json')
  }
}

function isLegacyBasenamePoseClipSidecarPath(sidecarWorkspacePath: string, sourceWorkspacePath: string): boolean {
  const sidecarName = basename(sidecarWorkspacePath)
  if (!sidecarName.endsWith(POSE_CLIP_SIDECAR_SUFFIX)) return false
  const sidecarStem = sidecarName.slice(0, -POSE_CLIP_SIDECAR_SUFFIX.length)
  const sourceName = basename(sourceWorkspacePath).replace(/\.[^.]+$/, '')
  return sidecarStem === sourceName
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateLandmarkPoint(value: unknown): string[] {
  if (!isRecord(value)) return ['invalid_landmark']

  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : '<unknown>'
  const errors: string[] = []
  if (!REQUIRED_LANDMARK_ID_SET.has(id)) errors.push(`invalid_landmark_id:${id}`)
  if (typeof value.name !== 'string' || value.name.length === 0) errors.push(`invalid_landmark_name:${id}`)
  if (!isRecord(value.world) || !isFiniteNumber(value.world.x) || !isFiniteNumber(value.world.y) || !isFiniteNumber(value.world.z)) {
    errors.push(`invalid_landmark_world:${id}`)
  }
  if (value.confidence !== 1) errors.push(`invalid_landmark_confidence:${id}`)
  if (value.source !== 'manual') errors.push(`invalid_landmark_source:${id}`)
  if (value.objectName !== undefined && typeof value.objectName !== 'string') errors.push(`invalid_landmark_object_name:${id}`)
  return errors
}

/**
 * Electron main intentionally keeps a minimal LandmarkSidecarV1-compatible validator
 * instead of importing renderer workflow helpers at runtime. This preserves the
 * Electron boundary while still rejecting malformed external IPC payloads.
 */
function validateLandmarkSidecarV1Payload(value: unknown, expectedSidecarPath: string, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.landmarks') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.runId !== 'string' || value.runId.length === 0) errors.push('invalid_run_id')
  if (typeof value.nodeId !== 'string' || value.nodeId.length === 0) errors.push('invalid_node_id')
  if (value.sidecarPath !== expectedSidecarPath) errors.push('invalid_sidecar_path')

  if (!isRecord(value.target)) {
    errors.push('invalid_target')
  } else {
    if (typeof value.target.artifactId !== 'string' || value.target.artifactId.length === 0) errors.push('invalid_target_artifact_id')
    if (typeof value.target.versionId !== 'string' || value.target.versionId.length === 0) errors.push('invalid_target_version_id')
    if (value.target.kind !== 'mesh') errors.push('invalid_target_kind')
    if (value.target.meshPath !== sourceWorkspacePath) errors.push('invalid_target_mesh_path')
  }

  if (!isRecord(value.artifacts)) {
    errors.push('invalid_artifacts')
  } else {
    if (value.artifacts.sidecarRole !== 'landmarks-sidecar') errors.push('invalid_sidecar_role')
    if (typeof value.artifacts.targetArtifactId !== 'string' || value.artifacts.targetArtifactId.length === 0) errors.push('invalid_target_artifact_id')
    if (typeof value.artifacts.targetVersionId !== 'string' || value.artifacts.targetVersionId.length === 0) errors.push('invalid_target_version_id')
  }

  const landmarks = Array.isArray(value.landmarks) ? value.landmarks : []
  if (!Array.isArray(value.landmarks)) errors.push('invalid_landmarks')

  const seenIds = new Set<string>()
  for (const landmark of landmarks) {
    if (isRecord(landmark) && typeof landmark.id === 'string') {
      if (seenIds.has(landmark.id)) errors.push(`duplicate_landmark:${landmark.id}`)
      seenIds.add(landmark.id)
    }
    errors.push(...validateLandmarkPoint(landmark))
  }
  for (const requiredId of REQUIRED_LANDMARK_IDS) {
    if (!seenIds.has(requiredId)) errors.push(`missing_required_landmark:${requiredId}`)
  }

  return errors
}

/**
 * Main-process validator for the renderer-built RigRenameSidecarV1 payload.
 * It validates the sidecar-only persistence boundary without importing renderer
 * runtime code into Electron main.
 */
function validateRigRenameSidecarV1Payload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.rig.rename-plan') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.skeletonContextId !== 'string' || value.skeletonContextId.length === 0) errors.push('invalid_skeleton_context_id')

  if (!isRecord(value.source)) {
    errors.push('invalid_source')
  } else {
    if (value.source.workspacePath !== sourceWorkspacePath) errors.push('invalid_source_workspacePath')
    if (value.source.artifactId !== undefined && typeof value.source.artifactId !== 'string') errors.push('invalid_source_artifact_id')
    if (value.source.versionId !== undefined && typeof value.source.versionId !== 'string') errors.push('invalid_source_version_id')
  }

  if (!isRecord(value.skeleton)) {
    errors.push('invalid_skeleton')
  } else {
    if (!Array.isArray(value.skeleton.rootBoneIds) || value.skeleton.rootBoneIds.some((id) => typeof id !== 'string' || id.length === 0)) errors.push('invalid_skeleton_root_bone_ids')
    if (typeof value.skeleton.boneCount !== 'number' || !Number.isInteger(value.skeleton.boneCount) || value.skeleton.boneCount < 1) errors.push('invalid_skeleton_bone_count')
    if (!Array.isArray(value.skeleton.bones) || value.skeleton.bones.length === 0) {
      errors.push('invalid_skeleton_bones')
    } else {
      for (const bone of value.skeleton.bones) {
        if (!isRecord(bone) || typeof bone.boneId !== 'string' || bone.boneId.length === 0) errors.push('invalid_skeleton_bone')
        if (!isRecord(bone) || typeof bone.oldLabel !== 'string' || bone.oldLabel.length === 0) errors.push('invalid_skeleton_bone_old_label')
        if (!isRecord(bone) || typeof bone.originalName !== 'string') errors.push('invalid_skeleton_bone_original_name')
        if (!isRecord(bone) || !Array.isArray(bone.path) || bone.path.some((segment) => typeof segment !== 'string')) errors.push('invalid_skeleton_bone_path')
      }
    }
  }

  if (!isRecord(value.aliases) || Object.keys(value.aliases).length === 0) {
    errors.push('invalid_aliases')
  } else {
    for (const [boneId, aliasEntry] of Object.entries(value.aliases)) {
      if (boneId.length === 0 || !isRecord(aliasEntry)) {
        errors.push('invalid_alias_entry')
        continue
      }
      if (typeof aliasEntry.oldLabel !== 'string' || aliasEntry.oldLabel.length === 0) errors.push(`invalid_alias_old_label:${boneId}`)
      if (typeof aliasEntry.alias !== 'string' || aliasEntry.alias.trim().length === 0) errors.push(`invalid_alias:${boneId}`)
    }
  }

  return errors
}

/**
 * Main-process validator for renderer-authored PoseClipSidecarV1 payloads.
 * Electron main keeps this minimal validation seam instead of importing renderer
 * helpers so the IPC persistence layer remains decoupled from React/Three code.
 */
function validatePoseClipSidecarV1Payload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.pose-clip') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.skeletonContextId !== 'string' || value.skeletonContextId.length === 0) errors.push('invalid_skeleton_context_id')

  if (!isRecord(value.source)) {
    errors.push('invalid_source')
  } else {
    if (value.source.workspacePath !== sourceWorkspacePath) errors.push('invalid_source_workspacePath')
    if (value.source.artifactId !== undefined && typeof value.source.artifactId !== 'string') errors.push('invalid_source_artifact_id')
    if (value.source.versionId !== undefined && typeof value.source.versionId !== 'string') errors.push('invalid_source_version_id')
  }

  if (!isRecord(value.clip)) {
    errors.push('invalid_clip')
  } else {
    if (typeof value.clip.id !== 'string' || value.clip.id.length === 0) errors.push('invalid_clip_id')
    if (typeof value.clip.name !== 'string' || value.clip.name.length === 0) errors.push('invalid_clip_name')
    if (!isFiniteNumber(value.clip.durationSeconds) || value.clip.durationSeconds <= 0) errors.push('invalid_clip_duration_seconds')
    if (!isFiniteNumber(value.clip.fps) || value.clip.fps <= 0) errors.push('invalid_clip_fps')
  }

  if (!isRecord(value.skeleton)) {
    errors.push('invalid_skeleton')
  } else {
    if (!Array.isArray(value.skeleton.rootBoneIds) || value.skeleton.rootBoneIds.some((id) => typeof id !== 'string' || id.length === 0)) errors.push('invalid_skeleton_root_bone_ids')
    if (typeof value.skeleton.boneCount !== 'number' || !Number.isInteger(value.skeleton.boneCount) || value.skeleton.boneCount < 1) errors.push('invalid_skeleton_bone_count')
    if (!Array.isArray(value.skeleton.bones) || value.skeleton.bones.length === 0) {
      errors.push('invalid_skeleton_bones')
    } else {
      for (const bone of value.skeleton.bones) {
        if (!isRecord(bone) || typeof bone.boneId !== 'string' || bone.boneId.length === 0) errors.push('invalid_skeleton_bone')
        if (!isRecord(bone) || typeof bone.label !== 'string' || bone.label.length === 0) errors.push('invalid_skeleton_bone_label')
        if (!isRecord(bone) || typeof bone.originalName !== 'string') errors.push('invalid_skeleton_bone_original_name')
        if (!isRecord(bone) || !Array.isArray(bone.path) || bone.path.some((segment) => typeof segment !== 'string')) errors.push('invalid_skeleton_bone_path')
      }
    }
  }

  if (!Array.isArray(value.keyframes)) {
    errors.push('invalid_keyframes')
  } else {
    for (const keyframe of value.keyframes) {
      if (!isRecord(keyframe) || typeof keyframe.id !== 'string' || keyframe.id.length === 0) errors.push('invalid_keyframe_id')
      if (!isRecord(keyframe) || !isFiniteNumber(keyframe.timeSeconds)) errors.push('invalid_keyframe_time_seconds')
      if (!isRecord(keyframe) || typeof keyframe.boneId !== 'string' || keyframe.boneId.length === 0) errors.push('invalid_keyframe_bone_id')
      if (!isRecord(keyframe) || !isQuaternionRecord(keyframe.rotation)) errors.push('invalid_keyframe_rotation')
      if (isRecord(keyframe) && keyframe.translation !== undefined && !isVector3Record(keyframe.translation)) errors.push('invalid_keyframe_translation')
      if (isRecord(keyframe) && keyframe.scale !== undefined && !isVector3Record(keyframe.scale)) errors.push('invalid_keyframe_scale')
    }
  }

  return errors
}

function isVector3Record(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function isQuaternionRecord(value: unknown): boolean {
  return isVector3Record(value) && isRecord(value) && isFiniteNumber(value.w)
}

function validateRigMetaPayload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_rigmeta']

  const errors: string[] = []
  const schema = value.schema ?? value.kind
  if (schema !== undefined && (typeof schema !== 'string' || !SUPPORTED_RIGMETA_SCHEMA_VALUES.has(schema))) {
    errors.push('invalid_schema')
  }

  const outputMesh = value.output_mesh ?? value.outputMesh
  if (outputMesh !== undefined) {
    if (typeof outputMesh !== 'string' || outputMesh.length === 0) {
      errors.push('invalid_output_mesh')
    } else if (basename(outputMesh.replace(/\\/g, '/')) !== basename(sourceWorkspacePath)) {
      errors.push('output_mesh_mismatch')
    }
  }

  return errors
}

function createRigMetaWorkspacePath(sourceWorkspacePath: string): string | null {
  if (!RIGMETA_MESH_EXTENSION_PATTERN.test(sourceWorkspacePath)) return null
  return sourceWorkspacePath.replace(RIGMETA_MESH_EXTENSION_PATTERN, '.rigmeta.json')
}

function normalizeRigMetaNamingForRead(rigMeta: unknown, sourceWorkspacePath: string): Pick<Extract<RigMetaSidecarReadResult, { status: 'found' }>, 'namingByBoneId' | 'warnings'> {
  const namingByBoneId: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'] = {}
  const warnings: string[] = []

  if (!isRecord(rigMeta)) {
    warnings.push('Rigmeta must be an object.')
    return { namingByBoneId, warnings }
  }

  const sourcePath = isRecord(rigMeta.source) && typeof rigMeta.source.workspacePath === 'string'
    ? rigMeta.source.workspacePath
    : null
  if (sourcePath && sourcePath !== sourceWorkspacePath) {
    warnings.push(`Rigmeta source mismatch: expected "${sourceWorkspacePath}" but found "${sourcePath}".`)
  }

  collectRigMetaNamingRecord(rigMeta.semantic_candidates, 'semantic_candidates', namingByBoneId, warnings)
  collectHumanoidDraftNaming(rigMeta.humanoid_draft, namingByBoneId, warnings)
  collectHumanoidContractNaming(rigMeta.humanoid_contract, rigMeta, namingByBoneId, warnings)

  if (Object.keys(namingByBoneId).length === 0) {
    warnings.push('Rigmeta did not contain supported naming entries.')
  }

  return { namingByBoneId, warnings }
}

function collectHumanoidContractNaming(
  value: unknown,
  rigMeta: Record<string, unknown>,
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  if (!isRecord(value)) return

  if (isRecord(value.required_roles)) {
    collectTrustedHumanoidContractRequiredRoles(value, rigMeta, output)
    return
  }

  const humanoidContract = isRecord(value.bones) ? value.bones : value
  collectRigMetaNamingRecord(humanoidContract, 'humanoid_contract', output, warnings)
}

function collectTrustedHumanoidContractRequiredRoles(
  contract: Record<string, unknown>,
  rigMeta: Record<string, unknown>,
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
): void {
  if (!isTrustedHumanoidRequiredRolesContract(contract, rigMeta)) return

  const knownBoneIds = new Set(Object.keys(output))
  for (const [role, assignment] of Object.entries(contract.required_roles as Record<string, unknown>)) {
    const boneId = extractHumanoidContractAssignmentKey(assignment)
    const label = humanizeRigMetaRoleLabel(role)
    if (!boneId || !label || !knownBoneIds.has(boneId)) continue

    output[boneId] = { label, source: 'humanoid_contract' }
  }
}

function isTrustedHumanoidRequiredRolesContract(contract: Record<string, unknown>, rigMeta: Record<string, unknown>): boolean {
  if (contract.schema !== 'modly.humanoid.v1') return false
  if ((contract.humanoid_contract_status ?? rigMeta.humanoid_contract_status) !== 'trusted') return false
  if (!isRecord(contract.validation) || contract.validation.status !== 'validated') return false

  const trustScope = isRecord(contract.provenance) && isRecord(contract.provenance.trust_scope)
    ? contract.provenance.trust_scope.trusted
    : null
  return Array.isArray(trustScope) && trustScope.includes('required_roles')
}

function extractHumanoidContractAssignmentKey(assignment: unknown): string | null {
  if (typeof assignment === 'string') return normalizeRigMetaLabel(assignment)
  if (!isRecord(assignment)) return null
  return normalizeRigMetaLabel(assignment.boneId)
}

function collectRigMetaNamingRecord(
  value: unknown,
  source: 'semantic_candidates' | 'humanoid_contract',
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  const record = source === 'semantic_candidates'
    ? resolveSemanticCandidatesNamingRecord(value)
    : value
  if (!isRecord(record)) return

  let invalidCount = 0
  for (const [boneId, candidate] of Object.entries(record)) {
    const label = extractRigMetaLabel(candidate)
    if (!label) {
      invalidCount += 1
      continue
    }
    output[boneId] = { label, source }
  }
  if (invalidCount > 0) {
    warnings.push(`Rigmeta naming was partially loaded; ${invalidCount} candidate label(s) were ignored.`)
  }
}

function collectHumanoidDraftNaming(
  value: unknown,
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  if (!isRecord(value) || !isRecord(value.assignments) || !isRecord(value.assignments.roles)) return

  let invalidCount = 0
  for (const [role, boneId] of Object.entries(value.assignments.roles)) {
    const normalizedBoneId = normalizeRigMetaLabel(boneId)
    const label = humanizeRigMetaRoleLabel(role)
    if (!normalizedBoneId || !label) {
      invalidCount += 1
      continue
    }
    output[normalizedBoneId] = { label, source: 'humanoid_draft' }
  }
  if (invalidCount > 0) {
    warnings.push(`Rigmeta naming was partially loaded; ${invalidCount} candidate label(s) were ignored.`)
  }
}

function resolveSemanticCandidatesNamingRecord(value: unknown): unknown {
  if (!isRecord(value)) return value
  return isRecord(value.roles) ? value.roles : value
}

function extractRigMetaLabel(candidate: unknown): string | null {
  if (typeof candidate === 'string') return normalizeRigMetaLabel(candidate)
  if (!isRecord(candidate)) return null

  for (const field of ['label', 'display_name', 'semantic_label', 'name', 'resolved_label']) {
    const label = normalizeRigMetaLabel(candidate[field])
    if (label) return label
  }
  return null
}

function normalizeRigMetaLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  return label.length > 0 ? label : null
}

function humanizeRigMetaRoleLabel(value: string): string | null {
  const normalized = normalizeRigMetaLabel(value)
  if (!normalized) return null
  return normalized
    .split(/[_-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

async function assertPathDoesNotExist(absolutePath: string, label: string): Promise<void> {
  try {
    await stat(absolutePath)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error(`Edited scene artifact ${label} already exists; refusing to overwrite`)
}

export async function writeArtifactSidecar(request: ArtifactRegistryWriteRequest): Promise<ArtifactRegistryWriteResult> {
  try {
    const assetPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath)
    const sidecarPath = resolveSidecarPath(request.workspaceDir, assetPath.workspacePath)
    const sidecar: ArtifactSidecar = {
      artifactId: request.artifactId,
      workspacePath: assetPath.workspacePath,
      metadata: request.metadata,
    }

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeFile(sidecarPath.absolutePath, JSON.stringify(sidecar, null, 2), 'utf-8')

    return { success: true, sidecar, sidecarPath: sidecarPath.workspacePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeEditedSceneArtifact(request: EditedSceneArtifactWriteServiceRequest): Promise<EditedSceneArtifactWriteResult> {
  try {
    const glbBytes = toByteBuffer(request.bytes)
    if (glbBytes.byteLength === 0) {
      throw new Error('Edited scene artifact bytes must be non-empty')
    }
    if (!isRecord(request.metadata)) {
      throw new Error('Edited scene artifact metadata must be a JSON object')
    }

    const glbPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.glbWorkspacePath)
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertEditedArtifactPathExtensions(glbPath.workspacePath, sidecarPath.workspacePath)
    assertEditedArtifactPrefix(glbPath.workspacePath, sidecarPath.workspacePath)

    if (glbPath.workspacePath === sourcePath.workspacePath || glbPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Edited scene artifact GLB path must not overwrite the source artifact')
    }
    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Edited scene artifact sidecar path must not overwrite the source artifact')
    }

    await assertPathDoesNotExist(glbPath.absolutePath, 'GLB')
    await assertPathDoesNotExist(sidecarPath.absolutePath, 'sidecar')

    await mkdir(dirname(glbPath.absolutePath), { recursive: true })
    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeFile(glbPath.absolutePath, glbBytes, { flag: 'wx' })
    await writeFile(sidecarPath.absolutePath, JSON.stringify(request.metadata, null, 2), { encoding: 'utf-8', flag: 'wx' })

    return {
      success: true,
      glbWorkspacePath: glbPath.workspacePath,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      metadata: request.metadata,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeLandmarkSidecar(request: LandmarkSidecarWriteServiceRequest): Promise<LandmarkSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertLandmarkSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Landmark sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validateLandmarkSidecarV1Payload(request.sidecar, sidecarPath.workspacePath, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid landmark sidecar v1: ${validationErrors.join(', ')}`)
    }

    const sidecar = request.sidecar as LandmarkSidecarWriteRequest['sidecar']

    await assertPathDoesNotExist(sidecarPath.absolutePath, 'landmark sidecar')
    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeFile(sidecarPath.absolutePath, JSON.stringify(sidecar, null, 2), { encoding: 'utf-8', flag: 'wx' })

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeRigRenameSidecar(request: RigRenameSidecarWriteServiceRequest): Promise<RigRenameSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertRigRenameSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Rig rename sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validateRigRenameSidecarV1Payload(request.sidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid rig rename sidecar v1: ${validationErrors.join(', ')}`)
    }

    const sidecar = request.sidecar as RigRenameSidecarWriteRequest['sidecar']

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeJsonAtomically(sidecarPath.absolutePath, sidecar)

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readRigRenameSidecar(request: RigRenameSidecarReadServiceRequest): Promise<RigRenameSidecarReadResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertRigRenameSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Rig rename sidecar path must not overwrite the source artifact')
    }

    let parsedSidecar: unknown
    try {
      parsedSidecar = JSON.parse(await readFile(sidecarPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', error: `Invalid rig rename sidecar JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validateRigRenameSidecarV1Payload(parsedSidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid rig rename sidecar v1: ${validationErrors.join(', ')}`)
    }

    return {
      success: true,
      status: 'found',
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: parsedSidecar as RigRenameSidecarV1,
    }
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writePoseClipSidecar(request: PoseClipSidecarWriteServiceRequest): Promise<PoseClipSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertPoseClipSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validatePoseClipSidecarV1Payload(request.sidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid pose clip sidecar v1: ${validationErrors.join(', ')}`)
    }

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeJsonAtomically(sidecarPath.absolutePath, request.sidecar)

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: request.sidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readPoseClipSidecar(request: PoseClipSidecarReadServiceRequest): Promise<PoseClipSidecarReadResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)
    const legacySidecarPath = request.legacySidecarWorkspacePath
      ? normalizeWorkspaceArtifactPath(request.workspaceDir, request.legacySidecarWorkspacePath)
      : null

    assertPoseClipSidecarPath(sidecarPath.workspacePath)
    if (legacySidecarPath) assertPoseClipSidecarPath(legacySidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }
    if (legacySidecarPath && (legacySidecarPath.workspacePath === sourcePath.workspacePath || legacySidecarPath.absolutePath === sourcePath.absolutePath)) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }

    const primaryResult = await readPoseClipSidecarAtPath(sidecarPath, sourcePath, true)
    if (primaryResult.status !== 'not-found' || !legacySidecarPath || legacySidecarPath.workspacePath === sidecarPath.workspacePath) {
      return primaryResult
    }

    return await readPoseClipSidecarAtPath(legacySidecarPath, sourcePath, true)
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

async function readPoseClipSidecarAtPath(
  sidecarPath: NormalizedWorkspaceArtifactPath,
  sourcePath: NormalizedWorkspaceArtifactPath,
  allowLegacySourceMismatch: boolean,
): Promise<PoseClipSidecarReadResult> {
  try {
    let parsedSidecar: unknown
    try {
      parsedSidecar = JSON.parse(await readFile(sidecarPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', error: `Invalid pose clip sidecar JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validatePoseClipSidecarV1Payload(parsedSidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      if (
        allowLegacySourceMismatch
        && validationErrors.length === 1
        && validationErrors[0] === 'invalid_source_workspacePath'
        && isLegacyBasenamePoseClipSidecarPath(sidecarPath.workspacePath, sourcePath.workspacePath)
      ) {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      throw new Error(`Invalid pose clip sidecar v1: ${validationErrors.join(', ')}`)
    }

    return {
      success: true,
      status: 'found',
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: parsedSidecar,
    }
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readRigMetaSidecar(request: RigMetaSidecarReadServiceRequest): Promise<RigMetaSidecarReadResult> {
  let rigMetaWorkspacePath: string | undefined

  try {
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)
    rigMetaWorkspacePath = createRigMetaWorkspacePath(sourcePath.workspacePath) ?? undefined
    if (!rigMetaWorkspacePath) {
      throw new Error('Rigmeta source path must be a workspace-relative .glb or .gltf mesh path')
    }

    const rigMetaPath = normalizeWorkspaceArtifactPath(request.workspaceDir, rigMetaWorkspacePath)

    let parsedRigMeta: unknown
    try {
      parsedRigMeta = JSON.parse(await readFile(rigMetaPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', rigMetaWorkspacePath: rigMetaPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', rigMetaWorkspacePath: rigMetaPath.workspacePath, message: `Invalid rigmeta JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validateRigMetaPayload(parsedRigMeta, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid rigmeta sidecar: ${validationErrors.join(', ')}`)
    }

    const naming = normalizeRigMetaNamingForRead(parsedRigMeta, sourcePath.workspacePath)

    return {
      success: true,
      status: 'found',
      rigMetaWorkspacePath: rigMetaPath.workspacePath,
      rigMeta: parsedRigMeta,
      namingByBoneId: naming.namingByBoneId,
      warnings: naming.warnings,
    }
  } catch (error) {
    return { success: false, status: 'invalid', ...(rigMetaWorkspacePath ? { rigMetaWorkspacePath } : {}), message: error instanceof Error ? error.message : String(error) }
  }
}

async function writeJsonAtomically(absolutePath: string, value: unknown): Promise<void> {
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' })
    await rename(tempPath, absolutePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

export async function readArtifactSidecar(request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> {
  try {
    const sidecarPath = resolveSidecarPath(request.workspaceDir, request.workspacePath)
    const rawSidecar = await readFile(sidecarPath.absolutePath, 'utf-8')
    const sidecar = JSON.parse(rawSidecar) as ArtifactSidecar
    return { success: true, sidecar }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerArtifactRegistryIpcHandlers({ ipcMain, getWorkspaceDir }: ArtifactRegistryIpcRegistrationDeps): void {
  ipcMain.handle('workspace:artifact:writeSidecar', async (_event, payload) => {
    try {
      return writeArtifactSidecar(parseWritePayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readSidecar', async (_event, payload) => {
    try {
      return readArtifactSidecar(parseReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeEditedSceneArtifact', async (_event, payload) => {
    try {
      return writeEditedSceneArtifact(parseEditedSceneArtifactPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeLandmarkSidecar', async (_event, payload) => {
    try {
      return writeLandmarkSidecar(parseLandmarkSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeRigRenameSidecar', async (_event, payload) => {
    try {
      return writeRigRenameSidecar(parseRigRenameSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readRigRenameSidecar', async (_event, payload) => {
    try {
      return readRigRenameSidecar(parseRigRenameSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writePoseClipSidecar', async (_event, payload) => {
    try {
      return writePoseClipSidecar(parsePoseClipSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readPoseClipSidecar', async (_event, payload) => {
    try {
      return readPoseClipSidecar(parsePoseClipSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readRigMetaSidecar', async (_event, payload) => {
    try {
      return readRigMetaSidecar(parseRigMetaSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', message: error instanceof Error ? error.message : String(error) }
    }
  })
}
