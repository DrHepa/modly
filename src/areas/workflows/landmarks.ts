import type { ArtifactRef } from '../../shared/types/artifacts.ts'

export const REQUIRED_LANDMARK_IDS = [
  'left_shoulder',
  'right_shoulder',
  'hip',
  'left_knee',
  'right_knee',
] as const

export type LandmarkId = typeof REQUIRED_LANDMARK_IDS[number]

export interface LandmarkWorldPoint {
  x: number
  y: number
  z: number
}

export interface LandmarkPoint {
  id: LandmarkId
  name: string
  world: LandmarkWorldPoint
  objectName?: string
  confidence: 1
  source: 'manual'
}

export interface LandmarkSidecarTargetV1 {
  artifactId: string
  versionId: string
  kind: 'mesh'
  meshPath: string
  lineage?: unknown
}

export interface LandmarkSidecarArtifactsV1 {
  sidecarRole: 'landmarks-sidecar'
  targetArtifactId: string
  targetVersionId: string
}

export interface LandmarkSidecarV1 {
  schema: 'modly.landmarks'
  version: 1
  createdAt: string
  runId: string
  nodeId: string
  sidecarPath: string
  target: LandmarkSidecarTargetV1
  artifacts: LandmarkSidecarArtifactsV1
  landmarks: LandmarkPoint[]
}

export interface LandmarkValidationResult {
  valid: boolean
  errors: string[]
}

export interface LandmarkCaptureValidity {
  valid: boolean
  missing: LandmarkId[]
}

export interface LandmarkCaptureState {
  nodeId: string
  targetArtifact: ArtifactRef
  activeLandmarkId: LandmarkId
  completed: Partial<Record<LandmarkId, LandmarkPoint>>
  validity: LandmarkCaptureValidity
  canContinue: boolean
  sidecarPath?: string
  error?: string
}

export interface BuildLandmarkSidecarV1Input {
  runId: string
  nodeId: string
  sidecarPath?: string
  targetArtifact: ArtifactRef
  meshPath: string
  createdAt?: string
  landmarks: readonly LandmarkPoint[]
  lineage?: unknown
}

export interface LandmarkCaptureIdentity {
  captureId: string
  captureRevision: number
  sidecarPath: string
}

const REQUIRED_LANDMARK_ID_SET = new Set<string>(REQUIRED_LANDMARK_IDS)
const SAFE_SIDECAR_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const LANDMARK_SIDECAR_PREFIX = 'Workflows/landmarks/'
const LANDMARK_SIDECAR_SUFFIX = '.landmarks.v1.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isLandmarkId(value: unknown): value is LandmarkId {
  return typeof value === 'string' && REQUIRED_LANDMARK_ID_SET.has(value)
}

function isLandmarkWorldPoint(value: unknown): value is LandmarkWorldPoint {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function isUnsafeSidecarId(value: string): boolean {
  return (
    value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || !SAFE_SIDECAR_ID_PATTERN.test(value)
  )
}

function assertSafeSidecarId(label: 'workflowId' | 'nodeId' | 'captureId', value: string): void {
  if (isUnsafeSidecarId(value)) {
    throw new Error(`Unsafe landmark sidecar id: ${label}`)
  }
}

function createLandmarkCaptureId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto)
  return `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function landmarkErrorId(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '<unknown>'
}

function validateLandmarkPoint(value: unknown): string[] {
  if (!isRecord(value)) return ['invalid_landmark']

  const idLabel = landmarkErrorId(value.id)
  const errors: string[] = []
  if (!isLandmarkId(value.id)) errors.push(`invalid_landmark_id:${idLabel}`)
  if (typeof value.name !== 'string' || value.name.length === 0) errors.push(`invalid_landmark_name:${idLabel}`)
  if (!isLandmarkWorldPoint(value.world)) errors.push(`invalid_landmark_world:${idLabel}`)
  if (value.confidence !== 1) errors.push(`invalid_landmark_confidence:${idLabel}`)
  if (value.source !== 'manual') errors.push(`invalid_landmark_source:${idLabel}`)
  if (value.objectName !== undefined && typeof value.objectName !== 'string') {
    errors.push(`invalid_landmark_object_name:${idLabel}`)
  }

  return errors
}

export function buildLandmarksSidecarPath(runId: string, nodeId: string, captureId: string): string {
  assertSafeSidecarId('workflowId', runId)
  assertSafeSidecarId('nodeId', nodeId)
  assertSafeSidecarId('captureId', captureId)
  return `${LANDMARK_SIDECAR_PREFIX}${runId}/${nodeId}/${captureId}${LANDMARK_SIDECAR_SUFFIX}`
}

export function createLandmarkCaptureIdentity(workflowId: string, nodeId: string, captureRevision = 1): LandmarkCaptureIdentity {
  const captureId = createLandmarkCaptureId()
  return {
    captureId,
    captureRevision,
    sidecarPath: buildLandmarksSidecarPath(workflowId, nodeId, captureId),
  }
}

function isValidLandmarkSidecarPathForIds(sidecarPath: string, runId: string, nodeId: string): boolean {
  if (sidecarPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(sidecarPath)) return false
  if (!sidecarPath.startsWith(LANDMARK_SIDECAR_PREFIX) || !sidecarPath.endsWith(LANDMARK_SIDECAR_SUFFIX)) return false

  const relative = sidecarPath.slice(LANDMARK_SIDECAR_PREFIX.length)
  const segments = relative.split('/')
  if (segments.length !== 2 && segments.length !== 3) return false
  if (segments.some((segment) => isUnsafeSidecarId(segment))) return false
  if (segments[0] !== runId) return false

  if (segments.length === 2) {
    const legacyFilename = `${nodeId}${LANDMARK_SIDECAR_SUFFIX}`
    return segments[1] === legacyFilename
  }

  return segments[1] === nodeId && segments[2].endsWith(LANDMARK_SIDECAR_SUFFIX)
}

export function getMissingRequiredLandmarkIds(landmarks: readonly Pick<LandmarkPoint, 'id'>[]): LandmarkId[] {
  const presentIds = new Set<LandmarkId>()
  for (const landmark of landmarks) {
    if (isLandmarkId(landmark.id)) presentIds.add(landmark.id)
  }
  return REQUIRED_LANDMARK_IDS.filter((id) => !presentIds.has(id))
}

export function isLandmarkCaptureComplete(landmarks: readonly Pick<LandmarkPoint, 'id'>[]): boolean {
  return getMissingRequiredLandmarkIds(landmarks).length === 0
}

export function buildLandmarkSidecarV1(input: BuildLandmarkSidecarV1Input): LandmarkSidecarV1 {
  return {
    schema: 'modly.landmarks',
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    runId: input.runId,
    nodeId: input.nodeId,
    sidecarPath: input.sidecarPath ?? buildLandmarksSidecarPath(input.runId, input.nodeId, createLandmarkCaptureId()),
    target: {
      artifactId: input.targetArtifact.id,
      versionId: input.targetArtifact.versionId,
      kind: 'mesh',
      meshPath: input.meshPath,
      ...(input.lineage !== undefined ? { lineage: input.lineage } : {}),
    },
    artifacts: {
      sidecarRole: 'landmarks-sidecar',
      targetArtifactId: input.targetArtifact.id,
      targetVersionId: input.targetArtifact.versionId,
    },
    landmarks: [...input.landmarks],
  }
}

export function validateLandmarkSidecarV1(value: unknown): LandmarkValidationResult {
  const errors: string[] = []

  if (!isRecord(value)) {
    return { valid: false, errors: ['invalid_sidecar'] }
  }

  if (value.schema !== 'modly.landmarks') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.runId !== 'string' || value.runId.length === 0) errors.push('invalid_run_id')
  if (typeof value.nodeId !== 'string' || value.nodeId.length === 0) errors.push('invalid_node_id')

  if (typeof value.sidecarPath !== 'string' || value.sidecarPath.length === 0) {
    errors.push('invalid_sidecar_path')
  } else if (typeof value.runId === 'string' && typeof value.nodeId === 'string') {
    try {
      if (!isValidLandmarkSidecarPathForIds(value.sidecarPath, value.runId, value.nodeId)) errors.push('invalid_sidecar_path')
    } catch {
      errors.push('invalid_sidecar_path')
    }
  }

  if (!isRecord(value.target)) {
    errors.push('invalid_target')
  } else {
    if (typeof value.target.artifactId !== 'string' || value.target.artifactId.length === 0) {
      errors.push('invalid_target_artifact_id')
    }
    if (typeof value.target.versionId !== 'string' || value.target.versionId.length === 0) {
      errors.push('invalid_target_version_id')
    }
    if (value.target.kind !== 'mesh') errors.push('invalid_target_kind')
    if (typeof value.target.meshPath !== 'string' || value.target.meshPath.length === 0) {
      errors.push('invalid_target_mesh_path')
    }
  }

  const landmarkValues = Array.isArray(value.landmarks) ? value.landmarks : []
  if (!Array.isArray(value.landmarks)) errors.push('invalid_landmarks')

  for (const missingId of getMissingRequiredLandmarkIds(landmarkValues)) {
    errors.push(`missing_required_landmark:${missingId}`)
  }

  const seenIds = new Set<LandmarkId>()
  for (const landmark of landmarkValues) {
    if (isRecord(landmark) && isLandmarkId(landmark.id)) {
      if (seenIds.has(landmark.id)) errors.push(`duplicate_landmark:${landmark.id}`)
      seenIds.add(landmark.id)
    }
    errors.push(...validateLandmarkPoint(landmark))
  }

  return { valid: errors.length === 0, errors }
}
