import type { KimodoMotionArtifact } from './kimodoMotionAdapter.ts'
import { resolveRigDisplayNames, type RigDisplayNameProvenance } from './rigDisplayNames.ts'
import type { RigMetaNamingMap } from './rigMetaNaming.ts'
import type { RigRenamePlan } from './rigRenamePlan.ts'
import { translateKimodoTargetTracks, type RigBoneId, type RigSkeletonSummary } from './rigSkeleton.ts'

const MIN_SAFE_TRANSLATED_TRACKS_FOR_MANUAL_WORKBENCH = 2
const BASIS_REST_POSE_PREVIEW_DISABLED_WARNING = 'Local rotation preview disabled because Kimodo omitted basis/rest-pose evidence; use animated GLB playback or export sidecar for rerun.'
const INVALID_BASIS_PREVIEW_DISABLED_WARNING = 'Local rotation preview disabled because Kimodo marked the retarget basis invalid; use animated GLB playback or export sidecar for rerun.'

export type MotionRetargetPreviewKind = 'preview-glb' | 'animated-glb'

export interface MotionRetargetSourceBone {
  sourceBoneId: string
  label: string
  rawLabel: string
  path: string[]
  parentSourceBoneId?: string
  role?: string
  chain?: string
}

export interface MotionRetargetTargetBone {
  boneId: RigBoneId
  label: string
  rawLabel: string
  originalName: string
  labelProvenance: RigDisplayNameProvenance
  nodeIndex?: number
  role?: string
  parentId?: RigBoneId
  childIds: RigBoneId[]
}

export interface MotionRetargetMappingEntry {
  sourceBoneId: string
  targetBoneId?: RigBoneId
  targetLabel?: string
  targetLabelProvenance?: RigDisplayNameProvenance
}

export interface MotionRetargetSessionSnapshot {
  selectedPreview?: MotionRetargetPreviewKind
  mappings?: Record<string, { targetBoneId?: RigBoneId }>
}

export interface MotionRetargetCorrectionsV1 {
  rootTranslationPolicy: 'solver' | 'in_place' | 'preserve_scaled_npz'
  rootMotionScale: number
  rootOffset: { x: number; y: number; z: number }
  previewMode?: 'before' | 'after'
}

export interface MotionRetargetCorrectionIdentityV1 {
  key: string
  sourceWorkspacePath: string
  skeletonContextId: string
  workflowId?: string
  workflowNodeId?: string
  bundleWorkspacePath?: string
  metadataWorkspacePath?: string
  artifactWorkspacePath?: string
}

export interface MotionRetargetSidecarV1Model {
  schema: 'modly.motion-retarget'
  version: 1
  createdAt: string
  source: { workspacePath: string; artifactId?: string; versionId?: string }
  identity: MotionRetargetCorrectionIdentityV1
  artifact: KimodoMotionArtifact
  sourceBones: MotionRetargetSourceBone[]
  session: MotionRetargetSessionSnapshot
  corrections: MotionRetargetCorrectionsV1
  warnings: string[]
  poseClip?: unknown
}

export type MotionRetargetCorrectionStateInput =
  | { status: 'idle' }
  | { status: 'dirty'; lastLoadedIdentityKey?: string; currentIdentityKey?: string }
  | { status: 'saved' | 'loaded'; sidecarWorkspacePath: string }
  | { status: 'error'; message: string }

export type MotionRetargetCorrectionState = {
  status: MotionRetargetCorrectionStateInput['status']
  dirty: boolean
  message: string
}

export const DEFAULT_MOTION_RETARGET_CORRECTIONS: MotionRetargetCorrectionsV1 = {
  rootTranslationPolicy: 'solver',
  rootMotionScale: 1,
  rootOffset: { x: 0, y: 0, z: 0 },
  previewMode: 'after',
}

export interface MotionRetargetDiagnosticsState {
  artifactWarnings: string[]
  mappingWarnings: string[]
  sourceWarnings: Record<string, string[]>
}

export interface MotionRetargetExportReadiness {
  canSaveSidecar: boolean
  canExportPoseClip: boolean
  coherentExportReady: boolean
  blockingWarnings: string[]
}

export interface MotionRetargetUnlockReadiness {
  playbackAvailable: boolean
  localRetargetReady: boolean
  trustedPayloadReady: boolean
  translationReady: boolean
  showSourceBones: boolean
  showMappingDisplay: boolean
  canPreview: boolean
  canSaveSidecar: boolean
  canExportPoseClip: boolean
  blockingWarnings: string[]
}

export interface MotionRetargetSession {
  artifact: KimodoMotionArtifact
  sourceBones: MotionRetargetSourceBone[]
  targetBones: MotionRetargetTargetBone[]
  selectedPreview: MotionRetargetPreviewKind
  mappings: Record<string, MotionRetargetMappingEntry>
  warnings: string[]
  diagnostics: MotionRetargetDiagnosticsState
  exportReadiness: MotionRetargetExportReadiness
  unlockReadiness: MotionRetargetUnlockReadiness
}

export interface CreateMotionRetargetSessionInput {
  artifact: KimodoMotionArtifact
  targetSummary: RigSkeletonSummary
  sourceBones: MotionRetargetSourceBone[]
  snapshot?: MotionRetargetSessionSnapshot
  renamePlan?: RigRenamePlan
  rigMetaNamingByBoneId?: RigMetaNamingMap
}

export function createMotionRetargetCorrectionIdentity(input: {
  sourceWorkspacePath?: string
  skeletonContextId?: string
  artifact: KimodoMotionArtifact
}): MotionRetargetCorrectionIdentityV1 {
  const sourceWorkspacePath = normalizeIdentityPart(input.sourceWorkspacePath)
  const skeletonContextId = input.skeletonContextId ?? 'rig:none|skeleton:0'
  const artifactWorkspacePath = normalizeIdentityPart(
    input.artifact.animatedGlbWorkspacePath
      ?? input.artifact.previewGlbWorkspacePath
      ?? input.artifact.canonicalMotionArtifactWorkspacePath
      ?? input.artifact.motionNpzWorkspacePath
      ?? input.artifact.metadataWorkspacePath
      ?? input.artifact.bundleWorkspacePath,
  )
  const identitySeed = stableJsonStringify({
    sourceWorkspacePath,
    skeletonContextId,
    workflowId: input.artifact.workflowId,
    workflowNodeId: input.artifact.workflowNodeId,
    extensionId: input.artifact.extensionId,
    nodeId: input.artifact.nodeId,
    bundleWorkspacePath: normalizeIdentityPart(input.artifact.bundleWorkspacePath),
    metadataWorkspacePath: normalizeIdentityPart(input.artifact.metadataWorkspacePath),
    artifactWorkspacePath,
    canonicalMotionArtifactWorkspacePath: normalizeIdentityPart(input.artifact.canonicalMotionArtifactWorkspacePath),
    motionNpzWorkspacePath: normalizeIdentityPart(input.artifact.motionNpzWorkspacePath),
    motionBvhWorkspacePath: normalizeIdentityPart(input.artifact.motionBvhWorkspacePath),
  })

  return {
    key: `mrt_${fnv1a64Hex(identitySeed)}`,
    sourceWorkspacePath,
    skeletonContextId,
    ...(input.artifact.workflowId ? { workflowId: input.artifact.workflowId } : {}),
    ...(input.artifact.workflowNodeId ? { workflowNodeId: input.artifact.workflowNodeId } : {}),
    ...(input.artifact.bundleWorkspacePath ? { bundleWorkspacePath: normalizeIdentityPart(input.artifact.bundleWorkspacePath) } : {}),
    ...(input.artifact.metadataWorkspacePath ? { metadataWorkspacePath: normalizeIdentityPart(input.artifact.metadataWorkspacePath) } : {}),
    ...(artifactWorkspacePath ? { artifactWorkspacePath } : {}),
  }
}

export function createMotionRetargetSidecarV1(input: {
  identity: MotionRetargetCorrectionIdentityV1
  session: MotionRetargetSession
  sourceWorkspacePath: string
  createdAt: string
  corrections?: Partial<MotionRetargetCorrectionsV1>
  warnings?: string[]
}): MotionRetargetSidecarV1Model {
  return {
    schema: 'modly.motion-retarget',
    version: 1,
    createdAt: input.createdAt,
    source: { workspacePath: normalizeIdentityPart(input.sourceWorkspacePath) },
    identity: structuredClone(input.identity),
    artifact: structuredClone(input.session.artifact),
    sourceBones: input.session.sourceBones.map(cloneSourceBone),
    session: {
      selectedPreview: input.session.selectedPreview,
      mappings: copySnapshotMappings(input.session.mappings),
    },
    corrections: normalizeMotionRetargetCorrections(input.corrections),
    warnings: [...(input.warnings ?? [])],
  }
}

export function hydrateMotionRetargetSessionSnapshotFromSidecar(input: {
  sidecar: Pick<MotionRetargetSidecarV1Model, 'identity' | 'session' | 'sourceBones' | 'corrections'>
  identity: MotionRetargetCorrectionIdentityV1
}):
  | { status: 'loaded'; snapshot: MotionRetargetSessionSnapshot; sourceBones: MotionRetargetSourceBone[]; corrections: MotionRetargetCorrectionsV1; warnings: string[] }
  | { status: 'identity-mismatch'; warnings: string[] } {
  if (input.sidecar.identity.key !== input.identity.key) {
    return { status: 'identity-mismatch', warnings: ['Motion Retarget sidecar belongs to a different workflow/artifact identity.'] }
  }
  return {
    status: 'loaded',
    snapshot: structuredClone(input.sidecar.session),
    sourceBones: input.sidecar.sourceBones.map(cloneSourceBone),
    corrections: normalizeMotionRetargetCorrections(input.sidecar.corrections),
    warnings: [],
  }
}

export function resolveMotionRetargetCorrectionState(input: MotionRetargetCorrectionStateInput): MotionRetargetCorrectionState {
  if (input.status === 'idle') return { status: 'idle', dirty: false, message: 'No saved correction sidecar loaded.' }
  if (input.status === 'dirty') return { status: 'dirty', dirty: true, message: 'Unsaved Motion Retarget corrections for this artifact.' }
  if (input.status === 'saved') return { status: 'saved', dirty: false, message: `Saved Motion Retarget corrections: ${input.sidecarWorkspacePath}` }
  if (input.status === 'loaded') return { status: 'loaded', dirty: false, message: `Loaded Motion Retarget corrections: ${input.sidecarWorkspacePath}` }
  return { status: 'error', dirty: false, message: input.message }
}

export type MotionRetargetSessionAction =
  | { type: 'hydrate'; snapshot?: MotionRetargetSessionSnapshot }
  | { type: 'set-preview'; selectedPreview: MotionRetargetPreviewKind }
  | { type: 'set-mapping'; sourceBoneId: string; targetBoneId?: RigBoneId }
  | { type: 'clear-mapping'; sourceBoneId: string }
  | { type: 'reset-mappings' }

export function createMotionRetargetSession(input: CreateMotionRetargetSessionInput): MotionRetargetSession {
  const sourceBones = resolveSourceBones(input.artifact, input.sourceBones)
  const targetBones = buildTargetBones(input.targetSummary, input.renamePlan, input.rigMetaNamingByBoneId)
  return buildSession({
    artifact: structuredClone(input.artifact),
    sourceBones,
    targetBones,
    snapshot: input.snapshot,
  })
}

export function reduceMotionRetargetSession(
  session: MotionRetargetSession,
  action: MotionRetargetSessionAction,
): MotionRetargetSession {
  if (action.type === 'hydrate') {
    return buildSession({
      artifact: structuredClone(session.artifact),
      sourceBones: session.sourceBones.map(cloneSourceBone),
      targetBones: session.targetBones.map(cloneTargetBone),
      snapshot: action.snapshot,
    })
  }

  if (action.type === 'set-preview') {
    const availablePreviews = resolveAvailablePreviews(session.artifact)
    if (!availablePreviews.includes(action.selectedPreview)) return cloneSession(session)
    return rebuildSession(session, { selectedPreview: action.selectedPreview, mappings: copySnapshotMappings(session.mappings) })
  }

  if (action.type === 'reset-mappings') {
    return rebuildSession(session, { selectedPreview: session.selectedPreview, mappings: {} })
  }

  const existingSourceBone = session.sourceBones.find((bone) => bone.sourceBoneId === action.sourceBoneId)
  if (!existingSourceBone) return cloneSession(session)

  const mappings = copySnapshotMappings(session.mappings)

  if (action.type === 'clear-mapping') {
    delete mappings[action.sourceBoneId]
    return rebuildSession(session, { selectedPreview: session.selectedPreview, mappings })
  }

  if (action.targetBoneId === undefined) {
    delete mappings[action.sourceBoneId]
    return rebuildSession(session, { selectedPreview: session.selectedPreview, mappings })
  }

  if (!session.targetBones.some((bone) => bone.boneId === action.targetBoneId)) return cloneSession(session)

  mappings[action.sourceBoneId] = { targetBoneId: action.targetBoneId }
  return rebuildSession(session, { selectedPreview: session.selectedPreview, mappings })
}

function rebuildSession(session: MotionRetargetSession, snapshot: MotionRetargetSessionSnapshot): MotionRetargetSession {
  return buildSession({
    artifact: structuredClone(session.artifact),
    sourceBones: session.sourceBones.map(cloneSourceBone),
    targetBones: session.targetBones.map(cloneTargetBone),
    snapshot,
  })
}

function buildSession(input: {
  artifact: KimodoMotionArtifact
  sourceBones: MotionRetargetSourceBone[]
  targetBones: MotionRetargetTargetBone[]
  snapshot?: MotionRetargetSessionSnapshot
}): MotionRetargetSession {
  const selectedPreview = resolveSelectedPreview(input.artifact, input.snapshot?.selectedPreview)
  const mappings = hydrateMappings(input.sourceBones, input.targetBones, input.snapshot?.mappings)
  const unlockReadiness = resolveMotionRetargetUnlockReadiness(input.artifact, input.sourceBones, input.targetBones)
  const diagnostics = validateSession(input.artifact, input.sourceBones, input.targetBones, mappings)
  const warnings = dedupeStrings([
    ...diagnostics.artifactWarnings,
    ...diagnostics.mappingWarnings,
    ...unlockReadiness.blockingWarnings,
  ])
  const coherentExportBlockingWarnings = resolveCoherentExportReadinessWarnings(input.artifact)

  return {
    artifact: input.artifact,
    sourceBones: input.sourceBones,
    targetBones: input.targetBones,
    selectedPreview,
    mappings,
    warnings,
    diagnostics,
    exportReadiness: {
      canSaveSidecar: unlockReadiness.canSaveSidecar,
      canExportPoseClip: unlockReadiness.canExportPoseClip,
      coherentExportReady: unlockReadiness.canExportPoseClip && coherentExportBlockingWarnings.length === 0,
      blockingWarnings: dedupeStrings([
        ...unlockReadiness.blockingWarnings,
        ...coherentExportBlockingWarnings,
      ]),
    },
    unlockReadiness,
  }
}

function buildTargetBones(
  summary: RigSkeletonSummary,
  renamePlan?: RigRenamePlan,
  rigMetaNamingByBoneId?: RigMetaNamingMap,
): MotionRetargetTargetBone[] {
  const displayNames = resolveRigDisplayNames({ summary, renamePlan, rigMetaNamingByBoneId })
  return summary.bones.map((bone) => {
    const display = displayNames.byBoneId[bone.boneId]
    return {
      boneId: bone.boneId,
      label: display?.label ?? bone.label,
      rawLabel: display?.rawLabel ?? bone.label,
      originalName: bone.originalName,
      labelProvenance: display?.provenance ?? 'raw',
      nodeIndex: bone.nodeIndex,
      role: bone.role,
      parentId: bone.parentId,
      childIds: [...bone.childIds],
    }
  })
}

function hydrateMappings(
  sourceBones: MotionRetargetSourceBone[],
  targetBones: MotionRetargetTargetBone[],
  snapshotMappings: MotionRetargetSessionSnapshot['mappings'],
): Record<string, MotionRetargetMappingEntry> {
  const sourceBoneIds = new Set(sourceBones.map((bone) => bone.sourceBoneId))
  const targetByBoneId = new Map(targetBones.map((bone) => [bone.boneId, bone] as const))
  const mappings: Record<string, MotionRetargetMappingEntry> = {}

  for (const sourceBone of sourceBones) {
    const snapshot = snapshotMappings?.[sourceBone.sourceBoneId]
    const targetBone = snapshot?.targetBoneId ? targetByBoneId.get(snapshot.targetBoneId) : undefined
    mappings[sourceBone.sourceBoneId] = targetBone
      ? {
          sourceBoneId: sourceBone.sourceBoneId,
          targetBoneId: targetBone.boneId,
          targetLabel: targetBone.label,
          targetLabelProvenance: targetBone.labelProvenance,
        }
      : { sourceBoneId: sourceBone.sourceBoneId }
  }

  if (!snapshotMappings) return mappings

  for (const sourceBoneId of Object.keys(snapshotMappings)) {
    if (!sourceBoneIds.has(sourceBoneId)) continue
    if (!mappings[sourceBoneId]) mappings[sourceBoneId] = { sourceBoneId }
  }

  return mappings
}

function validateSession(
  artifact: KimodoMotionArtifact,
  sourceBones: MotionRetargetSourceBone[],
  targetBones: MotionRetargetTargetBone[],
  mappings: Record<string, MotionRetargetMappingEntry>,
): MotionRetargetDiagnosticsState {
  const artifactWarnings = dedupeStrings([
    ...artifact.diagnostics.warnings,
    artifact.diagnostics.retargetErrorMessage ?? undefined,
  ])
  const mappingWarnings: string[] = []
  const sourceWarnings: Record<string, string[]> = {}
  const sourceById = new Map(sourceBones.map((bone) => [bone.sourceBoneId, bone] as const))
  const targetById = new Map(targetBones.map((bone) => [bone.boneId, bone] as const))
  const duplicateAssignments = new Map<RigBoneId, string[]>()

  for (const sourceBone of sourceBones) {
    sourceWarnings[sourceBone.sourceBoneId] = []
    const targetBoneId = mappings[sourceBone.sourceBoneId]?.targetBoneId
    if (!targetBoneId) {
      const warning = `Source bone "${sourceBone.label}" is not mapped.`
      sourceWarnings[sourceBone.sourceBoneId].push(warning)
      mappingWarnings.push(warning)
      continue
    }
    const assigned = duplicateAssignments.get(targetBoneId) ?? []
    assigned.push(sourceBone.sourceBoneId)
    duplicateAssignments.set(targetBoneId, assigned)
  }

  for (const [targetBoneId, sourceBoneIds] of duplicateAssignments) {
    if (sourceBoneIds.length < 2) continue
    const targetLabel = targetById.get(targetBoneId)?.label ?? targetBoneId
    const warning = `Target bone "${targetLabel}" is assigned to multiple source bones.`
    mappingWarnings.push(warning)
    for (const sourceBoneId of sourceBoneIds) {
      sourceWarnings[sourceBoneId]?.push(warning)
    }
  }

  for (const sourceBone of sourceBones) {
    const targetBoneId = mappings[sourceBone.sourceBoneId]?.targetBoneId
    if (!targetBoneId || !sourceBone.parentSourceBoneId) continue
    const parentTargetBoneId = mappings[sourceBone.parentSourceBoneId]?.targetBoneId
    if (!parentTargetBoneId) continue
    if (isTargetWithinParentContinuity(targetById, targetBoneId, parentTargetBoneId)) continue
    const warning = `Source bone "${sourceBone.label}" is mapped outside its parent continuity.`
    sourceWarnings[sourceBone.sourceBoneId]?.push(warning)
    mappingWarnings.push(warning)
  }

  return {
    artifactWarnings,
    mappingWarnings: dedupeStrings(mappingWarnings),
    sourceWarnings: Object.fromEntries(Object.entries(sourceWarnings).map(([sourceBoneId, warnings]) => [sourceBoneId, dedupeStrings(warnings)])),
  }
}

function isTargetWithinParentContinuity(
  targetById: ReadonlyMap<RigBoneId, MotionRetargetTargetBone>,
  targetBoneId: RigBoneId,
  parentTargetBoneId: RigBoneId,
): boolean {
  if (targetBoneId === parentTargetBoneId) return true
  return targetById.get(targetBoneId)?.parentId === parentTargetBoneId
}

function resolveSelectedPreview(
  artifact: KimodoMotionArtifact,
  requestedPreview: MotionRetargetPreviewKind | undefined,
): MotionRetargetPreviewKind {
  const available = resolveAvailablePreviews(artifact)
  if (requestedPreview && available.includes(requestedPreview)) return requestedPreview
  if (available.includes('animated-glb')) return 'animated-glb'
  return 'preview-glb'
}

function resolveAvailablePreviews(artifact: KimodoMotionArtifact): MotionRetargetPreviewKind[] {
  const available: MotionRetargetPreviewKind[] = []
  if (artifact.previewGlbWorkspacePath) available.push('preview-glb')
  if (artifact.animatedGlbWorkspacePath) available.push('animated-glb')
  return available
}

function copySnapshotMappings(mappings: Record<string, MotionRetargetMappingEntry>): Record<string, { targetBoneId?: RigBoneId }> {
  return Object.fromEntries(Object.entries(mappings)
    .filter(([, entry]) => entry.targetBoneId !== undefined)
    .map(([sourceBoneId, entry]) => [sourceBoneId, { targetBoneId: entry.targetBoneId }]))
}

function cloneSession(session: MotionRetargetSession): MotionRetargetSession {
  return {
    artifact: structuredClone(session.artifact),
    sourceBones: session.sourceBones.map(cloneSourceBone),
    targetBones: session.targetBones.map(cloneTargetBone),
    selectedPreview: session.selectedPreview,
    mappings: Object.fromEntries(Object.entries(session.mappings).map(([sourceBoneId, entry]) => [sourceBoneId, { ...entry }])),
    warnings: [...session.warnings],
    diagnostics: {
      artifactWarnings: [...session.diagnostics.artifactWarnings],
      mappingWarnings: [...session.diagnostics.mappingWarnings],
      sourceWarnings: Object.fromEntries(Object.entries(session.diagnostics.sourceWarnings).map(([sourceBoneId, warnings]) => [sourceBoneId, [...warnings]])),
    },
    exportReadiness: {
      canSaveSidecar: session.exportReadiness.canSaveSidecar,
      canExportPoseClip: session.exportReadiness.canExportPoseClip,
      coherentExportReady: session.exportReadiness.coherentExportReady,
      blockingWarnings: [...session.exportReadiness.blockingWarnings],
    },
    unlockReadiness: {
      playbackAvailable: session.unlockReadiness.playbackAvailable,
      localRetargetReady: session.unlockReadiness.localRetargetReady,
      trustedPayloadReady: session.unlockReadiness.trustedPayloadReady,
      translationReady: session.unlockReadiness.translationReady,
      showSourceBones: session.unlockReadiness.showSourceBones,
      showMappingDisplay: session.unlockReadiness.showMappingDisplay,
      canPreview: session.unlockReadiness.canPreview,
      canSaveSidecar: session.unlockReadiness.canSaveSidecar,
      canExportPoseClip: session.unlockReadiness.canExportPoseClip,
      blockingWarnings: [...session.unlockReadiness.blockingWarnings],
    },
  }
}

function cloneSourceBone(sourceBone: MotionRetargetSourceBone): MotionRetargetSourceBone {
  return {
    ...sourceBone,
    path: [...sourceBone.path],
  }
}

function cloneTargetBone(targetBone: MotionRetargetTargetBone): MotionRetargetTargetBone {
  return {
    ...targetBone,
    childIds: [...targetBone.childIds],
  }
}

function resolveSourceBones(
  artifact: KimodoMotionArtifact,
  sourceBones: readonly MotionRetargetSourceBone[],
): MotionRetargetSourceBone[] {
  const trustedSourceBones = artifact.motionRetarget?.status === 'parsed'
    ? artifact.motionRetarget.sourceBones.map((sourceBone) => ({
        sourceBoneId: sourceBone.sourceBoneId,
        label: sourceBone.label,
        rawLabel: sourceBone.rawLabel,
        path: sourceBone.parentSourceBoneId ? [sourceBone.parentSourceBoneId, sourceBone.label] : [sourceBone.label],
        ...(sourceBone.parentSourceBoneId ? { parentSourceBoneId: sourceBone.parentSourceBoneId } : {}),
        ...(sourceBone.role ? { role: sourceBone.role } : {}),
        ...(sourceBone.chain ? { chain: sourceBone.chain } : {}),
      }))
    : []
  return (trustedSourceBones.length > 0 ? trustedSourceBones : sourceBones).map(cloneSourceBone)
}

function resolveMotionRetargetUnlockReadiness(
  artifact: KimodoMotionArtifact,
  sourceBones: readonly MotionRetargetSourceBone[],
  targetBones: readonly MotionRetargetTargetBone[],
): MotionRetargetUnlockReadiness {
  const motionRetarget = artifact.motionRetarget
  if (!motionRetarget) {
    return blockedMotionRetargetUnlockReadiness(resolvePlaybackAvailable(artifact), 'Trusted Kimodo motion payload is unavailable.')
  }
  if (motionRetarget.status === 'invalid') {
    return blockedMotionRetargetUnlockReadiness(resolvePlaybackAvailable(artifact), ...motionRetarget.diagnostics)
  }
  const scopedTrust = resolveScopedSourceContractTrust(motionRetarget.sourceContract)
  if (!scopedTrust.ok) {
    return blockedMotionRetargetUnlockReadiness(resolvePlaybackAvailable(artifact), ...scopedTrust.warnings)
  }

  const translation = translateKimodoTargetTracks(createTargetSummaryForTranslation(targetBones), motionRetarget.targetTracks)
  if (!translation.ok) {
    return blockedMotionRetargetUnlockReadiness(resolvePlaybackAvailable(artifact), ...translation.diagnostics)
  }
  const unsafeTranslationDiagnostics = translation.diagnostics.filter(isUnsafeTranslationDiagnostic)
  if (unsafeTranslationDiagnostics.length > 0) {
    return blockedMotionRetargetUnlockReadiness(resolvePlaybackAvailable(artifact), ...unsafeTranslationDiagnostics)
  }

  const readinessDiagnostics = resolveRetargetReadinessDiagnostics(artifact)
  const localPreviewSafetyWarnings = resolveLocalPreviewSafetyWarnings(artifact)

  const hasSourceBones = sourceBones.length > 0
  const hasMinimumTranslatedTracks = translation.tracks.length >= MIN_SAFE_TRANSLATED_TRACKS_FOR_MANUAL_WORKBENCH
  const safeLocalPreviewReady = hasSourceBones && hasMinimumTranslatedTracks && localPreviewSafetyWarnings.length === 0
  const manualWorkbenchReady = hasSourceBones && hasMinimumTranslatedTracks
  const blockingWarnings = dedupeStrings([
    hasSourceBones ? undefined : 'Trusted Kimodo motion payload is missing source bone metadata.',
    hasMinimumTranslatedTracks ? undefined : `Kimodo local retarget preview requires at least ${MIN_SAFE_TRANSLATED_TRACKS_FOR_MANUAL_WORKBENCH} safe translated body tracks.`,
    ...localPreviewSafetyWarnings,
    ...translation.diagnostics,
    ...readinessDiagnostics,
  ])

  return {
    playbackAvailable: resolvePlaybackAvailable(artifact),
    localRetargetReady: safeLocalPreviewReady,
    trustedPayloadReady: true,
    translationReady: true,
    showSourceBones: hasSourceBones,
    showMappingDisplay: hasSourceBones,
    canPreview: safeLocalPreviewReady,
    canSaveSidecar: manualWorkbenchReady,
    canExportPoseClip: manualWorkbenchReady,
    blockingWarnings,
  }
}

function isUnsafeTranslationDiagnostic(diagnostic: string): boolean {
  return /ambiguous local target/i.test(diagnostic)
}

function blockedMotionRetargetUnlockReadiness(playbackAvailable: boolean, ...blockingWarnings: string[]): MotionRetargetUnlockReadiness {
  const warnings = dedupeStrings([
    playbackAvailable ? 'Animated GLB playback is available, but local retarget correctness is not proven.' : undefined,
    ...blockingWarnings,
  ])
  return {
    playbackAvailable,
    localRetargetReady: false,
    trustedPayloadReady: false,
    translationReady: false,
    showSourceBones: false,
    showMappingDisplay: false,
    canPreview: false,
    canSaveSidecar: false,
    canExportPoseClip: false,
    blockingWarnings: warnings.length > 0 ? warnings : ['Trusted Kimodo motion payload is unavailable.'],
  }
}

function resolvePlaybackAvailable(artifact: KimodoMotionArtifact): boolean {
  return Boolean(artifact.animatedGlbWorkspacePath || artifact.previewGlbWorkspacePath)
}

function resolveScopedSourceContractTrust(sourceContract: NonNullable<KimodoMotionArtifact['motionRetarget']>['sourceContract']): { ok: true } | { ok: false, warnings: string[] } {
  if (sourceContract?.trusted) return { ok: true }
  if (sourceContract?.status !== 'manual_confirmed') {
    return { ok: false, warnings: ['Trusted Kimodo motion payload is unavailable.'] }
  }
  if (!sourceContract.sidecarPayloadSha256 || !sourceContract.sidecarWorkspacePath) {
    return { ok: false, warnings: ['Kimodo manual_confirmed source contract requires scoped hash and workspace path evidence.'] }
  }
  return { ok: true }
}

function resolveRetargetReadinessDiagnostics(artifact: KimodoMotionArtifact): string[] {
  const motionRetarget = artifact.motionRetarget?.status === 'parsed' ? artifact.motionRetarget : undefined
  if (!motionRetarget) return []

  const diagnostics: string[] = []
  for (const omitted of motionRetarget.omittedChannels ?? []) {
    diagnostics.push(`Kimodo omitted ${omitted.channel} channel for ${omitted.targetNodeName}: ${omitted.reason}`)
  }

  const coverage = motionRetarget.coverage
  if (!coverage) return diagnostics

  for (const [label, bucket] of [
    ['root translation', coverage.rootTranslation],
    ['body coverage', coverage.body],
    ['hand coverage', coverage.hands],
    ['finger coverage', coverage.fingers],
  ] as const) {
    if (!bucket) continue
    const coveredRoles = bucket.coveredRoles ?? []
    const expectedRoles = bucket.expectedRoles ?? []
    const missingExpectedRoles = expectedRoles.filter((role) => !coveredRoles.includes(role))
    const status = bucket.status?.toLowerCase()
    if (status === 'complete' && missingExpectedRoles.length === 0) continue
    if (!status && missingExpectedRoles.length === 0) continue
    const missing = missingExpectedRoles.length > 0 ? ` Missing roles: ${missingExpectedRoles.join(', ')}.` : ''
    const reason = bucket.reason ? ` ${bucket.reason}` : ''
    diagnostics.push(`Kimodo ${label} is ${bucket.status ?? 'incomplete'}.${missing}${reason}`)
  }
  return diagnostics
}

function resolveCoherentExportReadinessWarnings(artifact: KimodoMotionArtifact): string[] {
  const diagnostics = artifact.diagnostics
  const warningsText = diagnostics.warnings.join('\n')
  const blockingWarnings: string[] = []
  const basisStatus = diagnostics.basisStatus?.toLowerCase()
  const visualQualityStatus = diagnostics.visualQualityStatus?.toLowerCase()
  const rootMotionStatus = diagnostics.rootMotionStatus?.toLowerCase()

  if (basisStatus === 'invalid' || /basis\/invalid|invalid_basis|basis_corrected_rotation_channels_skipped_invalid_basis/i.test(warningsText)) {
    blockingWarnings.push('Kimodo solver result is not coherent/export-ready: basis is invalid.')
  } else if (basisStatus === 'warning') {
    blockingWarnings.push('Kimodo solver result is not coherent/export-ready: basis evidence is warning.')
  }

  if (visualQualityStatus === 'warning' || visualQualityStatus === 'not_validated' || visualQualityStatus === 'preview-only' || /visual_quality|visual quality/i.test(warningsText)) {
    blockingWarnings.push('Kimodo solver result is not coherent/export-ready: visual quality is not validated.')
  }

  if (rootMotionStatus === 'preserve_root_motion' || /root[- ]motion correctness is deferred|root_motion_mode_preserve_translation/i.test(warningsText)) {
    blockingWarnings.push('Kimodo solver result is not coherent/export-ready: root-motion correctness is deferred.')
  }

  return dedupeStrings(blockingWarnings)
}

function resolveLocalPreviewSafetyWarnings(artifact: KimodoMotionArtifact): string[] {
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

function createTargetSummaryForTranslation(targetBones: readonly MotionRetargetTargetBone[]): RigSkeletonSummary {
  return {
    hasRig: targetBones.length > 0,
    skeletonContextId: 'motion-retarget:translation',
    skinnedMeshContexts: [],
    rootBoneIds: targetBones.filter((bone) => !bone.parentId).map((bone) => bone.boneId),
    stats: { skinnedMeshCount: 1, boneCount: targetBones.length },
    warnings: [],
    bones: targetBones.map((bone) => ({
      boneId: bone.boneId,
      label: bone.label,
      originalName: bone.originalName || bone.rawLabel || bone.label,
      nodeIndex: bone.nodeIndex,
      role: bone.role,
      path: [bone.label],
      siblingIndex: 0,
      ...(bone.parentId ? { parentId: bone.parentId } : {}),
      childIds: [...bone.childIds],
      warnings: [],
    })),
  }
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export function normalizeMotionRetargetCorrections(input?: Partial<MotionRetargetCorrectionsV1>): MotionRetargetCorrectionsV1 {
  const rootMotionScale = typeof input?.rootMotionScale === 'number' && Number.isFinite(input.rootMotionScale)
    ? Math.min(Math.max(input.rootMotionScale, 0), 3)
    : DEFAULT_MOTION_RETARGET_CORRECTIONS.rootMotionScale
  const rootOffset = input?.rootOffset
  const previewMode = input?.previewMode === 'before' || input?.previewMode === 'after'
    ? input.previewMode
    : DEFAULT_MOTION_RETARGET_CORRECTIONS.previewMode
  const rootTranslationPolicy = input?.rootTranslationPolicy === 'in_place' || input?.rootTranslationPolicy === 'preserve_scaled_npz' || input?.rootTranslationPolicy === 'solver'
    ? input.rootTranslationPolicy
    : DEFAULT_MOTION_RETARGET_CORRECTIONS.rootTranslationPolicy

  return {
    rootTranslationPolicy,
    rootMotionScale,
    rootOffset: {
      x: typeof rootOffset?.x === 'number' && Number.isFinite(rootOffset.x) ? rootOffset.x : 0,
      y: typeof rootOffset?.y === 'number' && Number.isFinite(rootOffset.y) ? rootOffset.y : 0,
      z: typeof rootOffset?.z === 'number' && Number.isFinite(rootOffset.z) ? rootOffset.z : 0,
    },
    previewMode,
  }
}

function normalizeIdentityPart(value: string | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
