import type { RigBoneId, RigBoneNode, RigSkeletonSummary } from './rigSkeleton.ts'

export const POSE_CLIP_SCHEMA = 'modly.pose-clip'
export const POSE_CLIP_VERSION = 1
export const POSE_CLIP_WORKSPACE_PREFIX = 'Workflows/pose-clips/'
export const POSE_CLIP_WORKSPACE_SUFFIX = '.pose-clip.v1.json'
export const MIN_POSE_CLIP_DURATION_SECONDS = 0.001
export const MIN_POSE_CLIP_FPS = 1

const POSE_CLIP_SOURCE_HASH_SEPARATOR = '--src-'
const POSE_CLIP_SOURCE_HASH_OFFSET = 0xcbf29ce484222325n
const POSE_CLIP_SOURCE_HASH_PRIME = 0x100000001b3n
const POSE_CLIP_SOURCE_HASH_MASK = 0xffffffffffffffffn

export interface PoseClipVector3 {
  x: number
  y: number
  z: number
}

export interface PoseClipQuaternion extends PoseClipVector3 {
  w: number
}

export interface PoseClipMetadata {
  id: string
  name: string
  durationSeconds: number
  fps: number
}

export interface PoseClipKeyframe {
  id: string
  timeSeconds: number
  boneId: RigBoneId
  rotation: PoseClipQuaternion
  translation?: PoseClipVector3
  scale?: PoseClipVector3
}

export interface PoseClipPlan {
  skeletonContextId: string
  clip: PoseClipMetadata
  selectedBoneId?: RigBoneId
  keyframes: PoseClipKeyframe[]
}

export type PoseClipInit = Partial<PoseClipMetadata> & { clipId?: string }

export type PoseClipPlanAction =
  | { type: 'init'; clip?: PoseClipInit }
  | { type: 'select-bone'; boneId: RigBoneId }
  | { type: 'set-clip-metadata'; durationSeconds?: number; fps?: number; name?: string; id?: string }
  | ({ type: 'capture-keyframe'; keyframeId: string; timeSeconds: number; rotation: PoseClipQuaternion; translation?: PoseClipVector3; scale?: PoseClipVector3 })
  | ({ type: 'update-keyframe'; keyframeId: string; timeSeconds?: number; rotation?: PoseClipQuaternion; translation?: PoseClipVector3; scale?: PoseClipVector3 })
  | { type: 'move-keyframe'; keyframeId: string; timeSeconds: number }
  | { type: 'shift-keyframe'; keyframeId: string; deltaSeconds: number }
  | { type: 'duplicate-keyframe'; keyframeId: string; timeSeconds?: number }
  | { type: 'delete-keyframe'; keyframeId: string }
  | { type: 'reset' }

export interface PoseClipSidecarSource {
  workspacePath: string
  artifactId?: string
  versionId?: string
}

export interface PoseClipSidecarBoneContext {
  boneId: RigBoneId
  label: string
  originalName: string
  path: string[]
}

export interface PoseClipSidecarV1 {
  schema: typeof POSE_CLIP_SCHEMA
  version: typeof POSE_CLIP_VERSION
  createdAt: string
  source: PoseClipSidecarSource
  skeletonContextId: string
  clip: PoseClipMetadata
  skeleton: {
    rootBoneIds: RigBoneId[]
    boneCount: number
    bones: PoseClipSidecarBoneContext[]
  }
  keyframes: PoseClipKeyframe[]
}

export interface BuildPoseClipSidecarInput {
  summary: RigSkeletonSummary
  plan: PoseClipPlan
  createdAt?: string
  source?: Partial<PoseClipSidecarSource>
}

export interface HydratePoseClipPlanOptions {
  sourceWorkspacePath: string
  skeletonContextId: string
}

export interface HydratePoseClipPlanResult {
  plan: PoseClipPlan
  warnings: string[]
  ignoredBoneIds: RigBoneId[]
  valid: boolean
}

export interface ValidatePoseClipSidecarWorkspacePathInput {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}

export interface PoseClipValidationResult {
  valid: boolean
  warnings: string[]
}

export function createPoseClipPlan(
  summary: Pick<RigSkeletonSummary, 'skeletonContextId'>,
  clip?: PoseClipInit,
): PoseClipPlan {
  return {
    skeletonContextId: summary.skeletonContextId,
    clip: createPoseClipMetadata(clip),
    keyframes: [],
  }
}

export function reducePoseClipPlan(
  summary: RigSkeletonSummary,
  plan: PoseClipPlan,
  action: PoseClipPlanAction,
): PoseClipPlan {
  if (action.type === 'init') {
    return createPoseClipPlan(summary, action.clip ?? plan.clip)
  }

  if (action.type === 'reset') {
    return createPoseClipPlan(summary, plan.clip)
  }

  if (action.type === 'select-bone') {
    if (!findBone(summary, action.boneId)) return clonePlan(summary, plan)
    return { ...clonePlan(summary, plan), selectedBoneId: action.boneId }
  }

  if (action.type === 'delete-keyframe') {
    return {
      ...clonePlan(summary, plan),
      keyframes: plan.keyframes.filter((keyframe) => keyframe.id !== action.keyframeId).map(cloneKeyframe),
    }
  }

  if (action.type === 'set-clip-metadata') {
    const durationSeconds = normalizeDurationSeconds(action.durationSeconds, plan.clip.durationSeconds)
    const fps = normalizeFps(action.fps, plan.clip.fps)
    return {
      ...clonePlan(summary, plan),
      clip: {
        id: action.id?.trim() || plan.clip.id,
        name: action.name?.trim() || plan.clip.name,
        durationSeconds,
        fps,
      },
      keyframes: orderedKeyframes(plan.keyframes.map((keyframe) => cloneKeyframe({
        ...keyframe,
        timeSeconds: clampPoseClipTime(keyframe.timeSeconds, durationSeconds),
      }))),
    }
  }

  if (action.type === 'update-keyframe') {
    return {
      ...clonePlan(summary, plan),
      keyframes: orderedKeyframes(plan.keyframes.map((keyframe) => {
        if (keyframe.id !== action.keyframeId) return cloneKeyframe(keyframe)
        return cloneKeyframe({
          ...keyframe,
          timeSeconds: action.timeSeconds === undefined ? keyframe.timeSeconds : clampPoseClipTime(action.timeSeconds, plan.clip.durationSeconds),
          rotation: action.rotation ?? keyframe.rotation,
          translation: action.translation ?? keyframe.translation,
          scale: action.scale ?? keyframe.scale,
        })
      })),
    }
  }

  if (action.type === 'move-keyframe' || action.type === 'shift-keyframe') {
    return {
      ...clonePlan(summary, plan),
      keyframes: orderedKeyframes(plan.keyframes.map((keyframe) => {
        if (keyframe.id !== action.keyframeId) return cloneKeyframe(keyframe)
        const nextTime = action.type === 'move-keyframe'
          ? action.timeSeconds
          : keyframe.timeSeconds + action.deltaSeconds
        return cloneKeyframe({
          ...keyframe,
          timeSeconds: clampPoseClipTime(nextTime, plan.clip.durationSeconds),
        })
      })),
    }
  }

  if (action.type === 'duplicate-keyframe') {
    const source = plan.keyframes.find((keyframe) => keyframe.id === action.keyframeId)
    if (!source) return clonePlan(summary, plan)
    const duplicateTime = action.timeSeconds === undefined
      ? source.timeSeconds + (1 / normalizeFps(plan.clip.fps, plan.clip.fps))
      : action.timeSeconds
    return {
      ...clonePlan(summary, plan),
      keyframes: orderedKeyframes([
        ...plan.keyframes.map(cloneKeyframe),
        cloneKeyframe({
          ...source,
          id: createPoseClipDuplicateKeyframeId(plan, source.id),
          timeSeconds: clampPoseClipTime(duplicateTime, plan.clip.durationSeconds),
        }),
      ]),
    }
  }

  const selectedBoneId = plan.selectedBoneId
  if (!selectedBoneId || !findBone(summary, selectedBoneId)) return clonePlan(summary, plan)

  return {
    ...clonePlan(summary, plan),
    keyframes: orderedKeyframes([
      ...plan.keyframes.map(cloneKeyframe),
      cloneKeyframe({
        id: action.keyframeId,
        timeSeconds: clampPoseClipTime(action.timeSeconds, plan.clip.durationSeconds),
        boneId: selectedBoneId,
        rotation: action.rotation,
        translation: action.translation,
        scale: action.scale,
      }),
    ]),
  }
}

export function buildPoseClipSidecarV1(input: BuildPoseClipSidecarInput): PoseClipSidecarV1 {
  const sourceWorkspacePath = input.source?.workspacePath ?? input.summary.sourceWorkspacePath
  if (!sourceWorkspacePath) {
    throw new Error('Pose clip sidecar requires a source workspace path.')
  }

  return {
    schema: POSE_CLIP_SCHEMA,
    version: POSE_CLIP_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: {
      workspacePath: sourceWorkspacePath,
      artifactId: input.source?.artifactId,
      versionId: input.source?.versionId,
    },
    skeletonContextId: input.summary.skeletonContextId,
    clip: cloneClipMetadata(input.plan.clip),
    skeleton: {
      rootBoneIds: [...input.summary.rootBoneIds],
      boneCount: input.summary.stats.boneCount,
      bones: input.summary.bones.map((bone) => sidecarBoneContext(bone)),
    },
    keyframes: orderedKeyframes(input.plan.keyframes.filter((keyframe) => findBone(input.summary, keyframe.boneId)).map(cloneKeyframe)),
  }
}

export function hydratePoseClipPlanFromSidecar(
  summary: RigSkeletonSummary,
  sidecar: unknown,
  options: HydratePoseClipPlanOptions,
): HydratePoseClipPlanResult {
  const emptyPlan = createPoseClipPlan(summary)
  const shapeWarnings = validatePoseClipSidecarShape(sidecar)
  if (shapeWarnings.length > 0) {
    return { plan: emptyPlan, warnings: shapeWarnings, ignoredBoneIds: [], valid: false }
  }

  const poseSidecar = sidecar as PoseClipSidecarV1
  if (poseSidecar.source.workspacePath !== options.sourceWorkspacePath) {
    return {
      plan: emptyPlan,
      warnings: [`Pose clip sidecar source mismatch: expected "${options.sourceWorkspacePath}" but found "${poseSidecar.source.workspacePath}".`],
      ignoredBoneIds: [],
      valid: false,
    }
  }
  if (poseSidecar.skeletonContextId !== options.skeletonContextId || poseSidecar.skeletonContextId !== summary.skeletonContextId) {
    return {
      plan: emptyPlan,
      warnings: [`Pose clip sidecar skeletonContextId mismatch: expected "${options.skeletonContextId}" but found "${poseSidecar.skeletonContextId}".`],
      ignoredBoneIds: [],
      valid: false,
    }
  }

  const warnings: string[] = []
  const ignoredBoneIds: RigBoneId[] = []
  const keyframes: PoseClipKeyframe[] = []
  const ignored = new Set<RigBoneId>()
  for (const keyframe of poseSidecar.keyframes) {
    if (!findBone(summary, keyframe.boneId)) {
      if (!ignored.has(keyframe.boneId)) {
        ignored.add(keyframe.boneId)
        ignoredBoneIds.push(keyframe.boneId)
        warnings.push(`Ignoring pose keyframes for unknown boneId "${keyframe.boneId}".`)
      }
      continue
    }
    keyframes.push(cloneKeyframe({
      ...keyframe,
      timeSeconds: clampPoseClipTime(keyframe.timeSeconds, poseSidecar.clip.durationSeconds),
    }))
  }

  return {
    plan: {
      skeletonContextId: summary.skeletonContextId,
      clip: cloneClipMetadata(poseSidecar.clip),
      keyframes: orderedKeyframes(keyframes),
    },
    warnings,
    ignoredBoneIds,
    valid: true,
  }
}

export function createPoseClipSidecarWorkspacePath(sourceWorkspacePath: string): string | null {
  const normalizedSourceWorkspacePath = normalizeSafePoseClipSourceWorkspacePath(sourceWorkspacePath)
  if (!normalizedSourceWorkspacePath) return null
  const sourceStem = createPoseClipSidecarStem(normalizedSourceWorkspacePath)
  const sourceHash = hashPoseClipSourceWorkspacePath(normalizedSourceWorkspacePath)
  return `${POSE_CLIP_WORKSPACE_PREFIX}${sourceStem}${POSE_CLIP_SOURCE_HASH_SEPARATOR}${sourceHash}${POSE_CLIP_WORKSPACE_SUFFIX}`
}

export function createLegacyPoseClipSidecarWorkspacePath(sourceWorkspacePath: string): string | null {
  const normalizedSourceWorkspacePath = normalizeSafePoseClipSourceWorkspacePath(sourceWorkspacePath)
  if (!normalizedSourceWorkspacePath) return null
  return `${POSE_CLIP_WORKSPACE_PREFIX}${createPoseClipSidecarStem(normalizedSourceWorkspacePath)}${POSE_CLIP_WORKSPACE_SUFFIX}`
}

export function validatePoseClipSidecarWorkspacePath(input: ValidatePoseClipSidecarWorkspacePathInput): PoseClipValidationResult {
  const warnings: string[] = []
  const normalizedSidecarPath = normalizeWorkspacePath(input.sidecarWorkspacePath)
  const normalizedSourcePath = normalizeWorkspacePath(input.sourceWorkspacePath)

  if (input.sidecarWorkspacePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(input.sidecarWorkspacePath)) {
    warnings.push('Pose clip sidecar path must be workspace-relative, not absolute.')
  }
  if (normalizedSidecarPath.split('/').includes('..')) {
    warnings.push('Pose clip sidecar path cannot contain traversal segments.')
  }
  if (!normalizedSidecarPath.startsWith(POSE_CLIP_WORKSPACE_PREFIX)) {
    warnings.push(`Pose clip sidecar path must be under ${POSE_CLIP_WORKSPACE_PREFIX}.`)
  }
  if (!normalizedSidecarPath.endsWith(POSE_CLIP_WORKSPACE_SUFFIX)) {
    warnings.push(`Pose clip sidecar path must end with ${POSE_CLIP_WORKSPACE_SUFFIX}.`)
  }
  if (normalizedSidecarPath === normalizedSourcePath) {
    warnings.push('Pose clip sidecar path cannot overwrite the source asset.')
  }

  return { valid: warnings.length === 0, warnings }
}

export function clampPoseClipTime(value: number, durationSeconds: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), normalizeDurationSeconds(durationSeconds, MIN_POSE_CLIP_DURATION_SECONDS))
}

export function createPoseClipDuplicateKeyframeId(plan: Pick<PoseClipPlan, 'keyframes'>, sourceId: string): string {
  const existingIds = new Set(plan.keyframes.map((keyframe) => keyframe.id))
  for (let suffix = 1; suffix <= existingIds.size + 1; suffix += 1) {
    const candidate = `${sourceId}__copy-${suffix}`
    if (!existingIds.has(candidate)) return candidate
  }
  return `${sourceId}__copy-${existingIds.size + 1}`
}

export function createPoseClipCaptureKeyframeId(
  plan: Pick<PoseClipPlan, 'clip' | 'keyframes'>,
  boneId: RigBoneId,
  timeSeconds: number,
): string {
  const clampedTime = clampPoseClipTime(timeSeconds, plan.clip.durationSeconds)
  const frame = Math.round(clampedTime * normalizeFps(plan.clip.fps, plan.clip.fps))
  const base = `kf-${slugId(boneId)}-${formatTimeToken(clampedTime)}-f${frame}`
  const existingIds = new Set(plan.keyframes.map((keyframe) => keyframe.id))
  for (let suffix = 1; suffix <= existingIds.size + 1; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!existingIds.has(candidate)) return candidate
  }
  return `${base}-${existingIds.size + 1}`
}

function createPoseClipMetadata(clip?: PoseClipInit): PoseClipMetadata {
  return {
    id: clip?.id?.trim() || clip?.clipId?.trim() || 'pose-clip',
    name: clip?.name?.trim() || 'Pose Clip',
    durationSeconds: normalizeDurationSeconds(clip?.durationSeconds, 1),
    fps: normalizeFps(clip?.fps, 24),
  }
}

function clonePlan(summary: RigSkeletonSummary, plan: PoseClipPlan): PoseClipPlan {
  return {
    skeletonContextId: summary.skeletonContextId,
    clip: cloneClipMetadata(plan.clip),
    selectedBoneId: plan.selectedBoneId,
    keyframes: plan.keyframes.map(cloneKeyframe),
  }
}

function cloneClipMetadata(clip: PoseClipMetadata): PoseClipMetadata {
  return {
    id: clip.id,
    name: clip.name,
    durationSeconds: clip.durationSeconds,
    fps: clip.fps,
  }
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

function findBone(summary: RigSkeletonSummary, boneId: RigBoneId): RigBoneNode | undefined {
  return summary.bones.find((bone) => bone.boneId === boneId)
}

function sidecarBoneContext(bone: RigBoneNode): PoseClipSidecarBoneContext {
  return {
    boneId: bone.boneId,
    label: bone.label,
    originalName: bone.originalName,
    path: [...bone.path],
  }
}

function orderedKeyframes(keyframes: PoseClipKeyframe[]): PoseClipKeyframe[] {
  return keyframes.map(cloneKeyframe).sort((left, right) => {
    if (left.timeSeconds !== right.timeSeconds) return left.timeSeconds - right.timeSeconds
    if (left.boneId !== right.boneId) return left.boneId.localeCompare(right.boneId)
    return left.id.localeCompare(right.id)
  })
}

function normalizeDurationSeconds(value: number | undefined, fallback: number): number {
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(numericValue, MIN_POSE_CLIP_DURATION_SECONDS)
}

function normalizeFps(value: number | undefined, fallback: number): number {
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(numericValue, MIN_POSE_CLIP_FPS)
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bone'
}

function formatTimeToken(timeSeconds: number): string {
  return `t${timeSeconds.toFixed(3).replace('.', 'p')}`
}

function validatePoseClipSidecarShape(sidecar: unknown): string[] {
  const warnings: string[] = []
  if (!isRecord(sidecar)) {
    return ['Pose clip sidecar is not an object.']
  }

  if (sidecar.schema !== POSE_CLIP_SCHEMA) {
    warnings.push('Pose clip sidecar schema must be "modly.pose-clip".')
  }
  if (sidecar.version !== POSE_CLIP_VERSION) {
    warnings.push('Pose clip sidecar version must be 1.')
  }
  if (!isRecord(sidecar.source) || typeof sidecar.source.workspacePath !== 'string' || sidecar.source.workspacePath.length === 0) {
    warnings.push('Pose clip sidecar source.workspacePath must be a non-empty string.')
  }
  if (typeof sidecar.skeletonContextId !== 'string') {
    warnings.push('Pose clip sidecar skeletonContextId must be a string.')
  }
  if (!isClipMetadata(sidecar.clip)) {
    warnings.push('Pose clip sidecar clip metadata is invalid.')
  }
  if (!isRecord(sidecar.skeleton) || !Array.isArray(sidecar.skeleton.rootBoneIds) || typeof sidecar.skeleton.boneCount !== 'number' || !Array.isArray(sidecar.skeleton.bones)) {
    warnings.push('Pose clip sidecar skeleton metadata is invalid.')
  }
  if (!Array.isArray(sidecar.keyframes) || !sidecar.keyframes.every(isPoseClipKeyframe)) {
    warnings.push('Pose clip sidecar keyframes must include id, timeSeconds, boneId and rotation quaternion.')
  }

  return warnings
}

function isClipMetadata(value: unknown): value is PoseClipMetadata {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.durationSeconds === 'number'
    && typeof value.fps === 'number'
}

function isPoseClipKeyframe(value: unknown): value is PoseClipKeyframe {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.timeSeconds === 'number'
    && typeof value.boneId === 'string'
    && isQuaternion(value.rotation)
    && (value.translation === undefined || isVector3(value.translation))
    && (value.scale === undefined || isVector3(value.scale))
}

function isQuaternion(value: unknown): value is PoseClipQuaternion {
  return isVector3(value) && typeof (value as unknown as Record<string, unknown>).w === 'number'
}

function isVector3(value: unknown): value is PoseClipVector3 {
  return isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createPoseClipSidecarStem(sourceWorkspacePath: string): string {
  const normalized = normalizeWorkspacePath(sourceWorkspacePath)
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? 'pose-clip'
  const withoutExtension = filename.replace(/\.[^.]+$/, '') || 'pose-clip'
  return withoutExtension.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'pose-clip'
}

function normalizeSafePoseClipSourceWorkspacePath(sourceWorkspacePath: string): string | null {
  const trimmed = sourceWorkspacePath.trim()
  if (!trimmed) return null
  if (trimmed.includes('\\')) return null
  if (trimmed.startsWith('/') || /^[a-zA-Z]:[\/]/.test(trimmed)) return null

  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return segments.join('/')
}

function hashPoseClipSourceWorkspacePath(normalizedSourceWorkspacePath: string): string {
  let hash = POSE_CLIP_SOURCE_HASH_OFFSET
  for (const character of normalizedSourceWorkspacePath) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = (hash * POSE_CLIP_SOURCE_HASH_PRIME) & POSE_CLIP_SOURCE_HASH_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/')
}
