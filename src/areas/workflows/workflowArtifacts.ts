import type {
  ArtifactKind,
  ArtifactLineage,
  ArtifactProvenance,
  ArtifactReplacementResult,
  ArtifactRef,
  ArtifactSubstitution,
  ArtifactSubstitutionPoint,
  ArtifactVersion,
  LegacyArtifactPayload,
} from '../../shared/types/artifacts.ts'

export interface LegacyWorkflowOutput {
  filePath?: string
  text?: string
  outputType?: string
}

export interface ArtifactRefAdapterOptions {
  artifactId?: string
  versionId?: string
  provenance?: ArtifactProvenance
}

export interface ArtifactLineageOptions {
  createdAt?: string
}

export interface DeclaredArtifactSubstitutionInput {
  nodeId: string
  inputArtifactId: string
  allowedKinds: ArtifactKind[]
}

export interface DeclaredArtifactSubstitutionPointInput {
  nodeId: string
  inputArtifact: ArtifactRef
  allowedKinds?: ArtifactKind[]
}

export interface ResolveArtifactReplacementOptions {
  currentNodeId?: string
}

export type ArtifactHistoryRowKind =
  | 'checkpoint-original'
  | 'pending-edited-copy'
  | 'replacement-used'
  | 'original-used'
  | 'final-output'
  | 'legacy-info'
  | 'landmark-sidecar'

export type ArtifactHistoryRowStatus = 'pending' | 'used' | 'skipped' | 'available'

export interface ArtifactHistoryRow {
  kind: ArtifactHistoryRowKind
  label: string
  description: string
  artifact?: ArtifactRef
  status?: ArtifactHistoryRowStatus
}

export interface DeriveArtifactHistoryRowsInput {
  waitNodeId?: string
  nodeArtifacts?: Record<string, ArtifactRef>
  artifactLineages?: Record<string, ArtifactLineage>
  substitutionPoint?: ArtifactSubstitutionPoint
  runArtifact?: ArtifactRef
  replacementResult?: ArtifactReplacementResult
  pendingReplacement?: ArtifactRef
  landmarkSidecar?: LandmarkSidecarLineageMetadata
}

export interface BuildLandmarkSidecarLineageMetadataInput {
  runId: string
  nodeId: string
  sidecarWorkspacePath: string
  targetArtifact: ArtifactRef
  targetMeshPath: string
}

export interface LandmarkSidecarLineageMetadata {
  sidecarRole: 'landmarks-sidecar'
  runId: string
  nodeId: string
  sidecarWorkspacePath: string
  targetArtifactId: string
  targetVersionId: string
  targetMeshPath: string
  downstreamParam: 'landmarks_sidecar_path'
}

export interface BuildEditedCheckpointArtifactRefInput {
  workspacePath: string
  sidecarWorkspacePath: string
  createdAt: string
}

export interface EditedCheckpointArtifactLineageIntent {
  type: 'edited-checkpoint-copy'
  sourceArtifactId: string
  sourceVersionId: string
  editedVersionId: string
  sidecarWorkspacePath: string
  pendingReplacement: false
}

export interface EditedCheckpointArtifactRefResult {
  artifact: ArtifactRef
  lineageIntent: EditedCheckpointArtifactLineageIntent
}

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(['image', 'text', 'mesh', 'scene'])

function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && ARTIFACT_KIND_SET.has(value as ArtifactKind)
}

function inferArtifactKind(output: LegacyWorkflowOutput): ArtifactKind | undefined {
  if (isArtifactKind(output.outputType)) return output.outputType
  if (output.text !== undefined) return 'text'
  return undefined
}

function stableSegment(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0
  }
  return Math.abs(hash).toString(36)
}

function legacyPayloadFor(output: LegacyWorkflowOutput, kind: ArtifactKind): LegacyArtifactPayload {
  return {
    ...(output.filePath !== undefined ? { filePath: output.filePath } : {}),
    ...(output.text !== undefined ? { text: output.text } : {}),
    outputType: kind,
  }
}

export function legacyOutputToArtifactRef(
  output: LegacyWorkflowOutput | undefined,
  options: ArtifactRefAdapterOptions = {},
): ArtifactRef | undefined {
  if (!output || (output.filePath === undefined && output.text === undefined)) {
    return undefined
  }

  const kind = inferArtifactKind(output)
  if (!kind) return undefined

  const identitySource = `${kind}:${output.filePath ?? ''}:${output.text ?? ''}`
  const artifactId = options.artifactId ?? `artifact-${stableSegment(identitySource)}`
  const versionId = options.versionId ?? `${artifactId}-original`

  return {
    id: artifactId,
    kind,
    ...(output.filePath !== undefined ? { uri: output.filePath } : {}),
    ...(output.text !== undefined ? { text: output.text } : {}),
    versionId,
    legacy: legacyPayloadFor(output, kind),
    ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
  }
}

export function artifactRefToLegacyOutput(ref: ArtifactRef | undefined): LegacyArtifactPayload | undefined {
  if (!ref) return undefined

  const outputType = ref.legacy?.outputType ?? ref.kind
  const filePath = ref.legacy?.filePath ?? ref.uri
  const text = ref.legacy?.text ?? ref.text

  if (outputType === 'text' && text === undefined) {
    return undefined
  }

  if ((outputType === 'mesh' || outputType === 'image' || outputType === 'scene') && filePath === undefined) {
    return undefined
  }

  return {
    ...(filePath !== undefined ? { filePath } : {}),
    ...(text !== undefined ? { text } : {}),
    outputType,
  }
}

export function createArtifactLineage(
  originalRef: ArtifactRef,
  options: ArtifactLineageOptions = {},
): ArtifactLineage {
  const originalVersion: ArtifactVersion = {
    id: originalRef.versionId,
    role: 'original',
    ref: originalRef,
    createdAt: options.createdAt ?? new Date().toISOString(),
  }

  return {
    artifactId: originalRef.id,
    originalVersionId: originalRef.versionId,
    currentVersionId: originalRef.versionId,
    versions: [originalVersion],
  }
}

export function replaceCurrentArtifactVersion(
  lineage: ArtifactLineage,
  editedRef: ArtifactRef,
  options: ArtifactLineageOptions = {},
): ArtifactLineage {
  const editedVersion: ArtifactVersion = {
    id: editedRef.versionId,
    role: 'edited',
    ref: editedRef,
    createdAt: options.createdAt ?? new Date().toISOString(),
    parentVersionId: lineage.currentVersionId,
  }

  return {
    ...lineage,
    currentVersionId: editedRef.versionId,
    versions: [...lineage.versions, editedVersion],
  }
}

export function createDeclaredArtifactSubstitution(
  input: DeclaredArtifactSubstitutionInput,
): ArtifactSubstitution {
  return {
    nodeId: input.nodeId,
    inputArtifactId: input.inputArtifactId,
    allowedKinds: input.allowedKinds,
    status: 'declared',
  }
}

export function createDeclaredArtifactSubstitutionPoint(
  input: DeclaredArtifactSubstitutionPointInput,
): ArtifactSubstitutionPoint {
  return {
    kind: 'artifact_substitution',
    nodeId: input.nodeId,
    inputArtifactId: input.inputArtifact.id,
    inputArtifact: input.inputArtifact,
    allowedKinds: input.allowedKinds ?? [input.inputArtifact.kind],
    status: 'declared',
    interaction: {
      boundary: 'ui_only',
      headless: false,
      editor: 'none',
      continueMode: 'manual',
    },
  }
}

export function resolveArtifactReplacement(
  point: ArtifactSubstitutionPoint,
  replacement?: ArtifactRef,
  options: ResolveArtifactReplacementOptions = {},
): ArtifactReplacementResult {
  const originalLegacy = artifactRefToLegacyOutput(point.inputArtifact)

  if (options.currentNodeId !== undefined && options.currentNodeId !== point.nodeId) {
    return {
      status: 'rejected',
      reason: 'stale_checkpoint',
      artifact: point.inputArtifact,
      ...(originalLegacy !== undefined ? { legacy: originalLegacy } : {}),
    }
  }

  if (!replacement) {
    return {
      status: 'noop',
      reason: 'no_replacement',
      artifact: point.inputArtifact,
      ...(originalLegacy !== undefined ? { legacy: originalLegacy } : {}),
    }
  }

  if (!point.allowedKinds.includes(replacement.kind)) {
    return {
      status: 'rejected',
      reason: 'kind_not_allowed',
      artifact: point.inputArtifact,
      ...(originalLegacy !== undefined ? { legacy: originalLegacy } : {}),
    }
  }

  const replacementLegacy = artifactRefToLegacyOutput(replacement)
  if (!replacementLegacy) {
    return {
      status: 'rejected',
      reason: 'legacy_unavailable',
      artifact: point.inputArtifact,
      ...(originalLegacy !== undefined ? { legacy: originalLegacy } : {}),
    }
  }

  return {
    status: 'accepted',
    artifact: replacement,
    legacy: replacementLegacy,
  }
}

export function buildWaitReplacementArtifactRef(originalRef: ArtifactRef, replacementRef: ArtifactRef): ArtifactRef {
  const replacementLegacy = artifactRefToLegacyOutput(replacementRef)
  const editedVersionId = `${originalRef.id}-${replacementRef.versionId}`

  return {
    id: originalRef.id,
    kind: replacementRef.kind,
    ...(replacementRef.uri !== undefined ? { uri: replacementRef.uri } : {}),
    ...(replacementRef.text !== undefined ? { text: replacementRef.text } : {}),
    versionId: editedVersionId,
    ...(replacementLegacy !== undefined ? { legacy: replacementLegacy } : {}),
  }
}

export function buildEditedCheckpointArtifactRef(
  originalRef: ArtifactRef,
  input: BuildEditedCheckpointArtifactRefInput,
): EditedCheckpointArtifactRefResult {
  const editedVersionId = `${originalRef.id}-edited-${timestampToken(input.createdAt)}`
  const artifact: ArtifactRef = {
    id: originalRef.id,
    kind: 'mesh',
    uri: input.workspacePath,
    versionId: editedVersionId,
    legacy: { filePath: input.workspacePath, outputType: 'mesh' },
  }

  return {
    artifact,
    lineageIntent: {
      type: 'edited-checkpoint-copy',
      sourceArtifactId: originalRef.id,
      sourceVersionId: originalRef.versionId,
      editedVersionId,
      sidecarWorkspacePath: input.sidecarWorkspacePath,
      pendingReplacement: false,
    },
  }
}

export function buildLandmarkSidecarLineageMetadata(
  input: BuildLandmarkSidecarLineageMetadataInput,
): LandmarkSidecarLineageMetadata {
  return {
    sidecarRole: 'landmarks-sidecar',
    runId: input.runId,
    nodeId: input.nodeId,
    sidecarWorkspacePath: input.sidecarWorkspacePath,
    targetArtifactId: input.targetArtifact.id,
    targetVersionId: input.targetArtifact.versionId,
    targetMeshPath: input.targetMeshPath,
    downstreamParam: 'landmarks_sidecar_path',
  }
}

export function buildWaitArtifactLineage(
  lineage: ArtifactLineage | undefined,
  originalRef: ArtifactRef,
  editedRef: ArtifactRef,
  options: ArtifactLineageOptions = {},
): ArtifactLineage {
  const baseLineage = lineage ?? createArtifactLineage(originalRef, options)
  return replaceCurrentArtifactVersion(baseLineage, editedRef, options)
}

export function deriveArtifactHistoryRows(input: DeriveArtifactHistoryRowsInput): ArtifactHistoryRow[] {
  const rows: ArtifactHistoryRow[] = []
  const originalArtifact = resolveOriginalHistoryArtifact(input)

  if (originalArtifact) {
    rows.push({
      kind: 'checkpoint-original',
      label: 'Temporary checkpoint',
      description: `Starting artifact: ${describeArtifact(originalArtifact)}.`,
      artifact: originalArtifact,
      status: 'available',
    })
  }

  if (input.pendingReplacement) {
    rows.push({
      kind: 'pending-edited-copy',
      label: 'Edited copy pending',
      description: `Edited copy: ${describeArtifact(input.pendingReplacement)}. It will only be used if you continue with it.`,
      artifact: input.pendingReplacement,
      status: 'pending',
    })
  }

  if (input.landmarkSidecar) {
    const targetArtifact = resolveLandmarkSidecarHistoryArtifact(input)
    rows.push({
      kind: 'landmark-sidecar',
      label: 'Landmark sidecar',
      description: `Manual landmarks sidecar: ${input.landmarkSidecar.sidecarWorkspacePath} for mesh at ${input.landmarkSidecar.targetMeshPath} (version ${input.landmarkSidecar.targetVersionId}).`,
      ...(targetArtifact !== undefined ? { artifact: targetArtifact } : {}),
      status: 'available',
    })
  }

  if (input.replacementResult?.status === 'accepted') {
    rows.push({
      kind: 'replacement-used',
      label: 'Replacement used',
      description: `Continue used the edited artifact: ${describeArtifact(input.replacementResult.artifact)}.`,
      artifact: input.replacementResult.artifact,
      status: 'used',
    })
  } else if (input.replacementResult?.status === 'rejected' || input.replacementResult?.status === 'noop') {
    const usedArtifact = input.replacementResult.artifact ?? originalArtifact
    if (usedArtifact) {
      rows.push({
        kind: 'original-used',
        label: 'Original used',
        description: `Continue kept the original artifact: ${describeArtifact(usedArtifact)}. No replacement was applied.`,
        artifact: usedArtifact,
        status: 'skipped',
      })
    }
  }

  if (input.runArtifact) {
    rows.push({
      kind: 'final-output',
      label: 'Final output',
      description: `Current output: ${describeArtifact(input.runArtifact)}.`,
      artifact: input.runArtifact,
      status: 'available',
    })
  }

  if (rows.length === 0) {
    const legacyArtifact = firstArtifact(input.nodeArtifacts)
    if (legacyArtifact) {
      rows.push({
        kind: 'legacy-info',
        label: 'Artifact info',
        description: `Artifact info: ${describeArtifact(legacyArtifact)}.`,
        artifact: legacyArtifact,
        status: 'available',
      })
    }
  }

  return rows
}

function resolveLandmarkSidecarHistoryArtifact(input: DeriveArtifactHistoryRowsInput): ArtifactRef | undefined {
  if (!input.landmarkSidecar) return undefined
  const nodeArtifact = input.nodeArtifacts?.[input.landmarkSidecar.nodeId]
  if (nodeArtifact) return nodeArtifact

  return Object.values(input.nodeArtifacts ?? {}).find((artifact) => artifact.id === input.landmarkSidecar?.targetArtifactId)
}

function resolveOriginalHistoryArtifact(input: DeriveArtifactHistoryRowsInput): ArtifactRef | undefined {
  if (input.substitutionPoint?.inputArtifact) return input.substitutionPoint.inputArtifact

  if (input.waitNodeId && input.nodeArtifacts?.[input.waitNodeId]) return input.nodeArtifacts[input.waitNodeId]

  const firstLineage = firstLineageValue(input.artifactLineages)
  const originalVersion = firstLineage?.versions.find((version) => version.id === firstLineage.originalVersionId)
  return originalVersion?.ref
}

function firstLineageValue(lineages: Record<string, ArtifactLineage> | undefined): ArtifactLineage | undefined {
  if (!lineages) return undefined
  return Object.values(lineages)[0]
}

function firstArtifact(artifacts: Record<string, ArtifactRef> | undefined): ArtifactRef | undefined {
  if (!artifacts) return undefined
  return Object.values(artifacts)[0]
}

function describeArtifact(artifact: ArtifactRef): string {
  const location = artifact.uri ?? artifact.legacy?.filePath
  const locationSegment = location ? ` at ${location}` : ''
  return `${artifact.kind}${locationSegment} (version ${artifact.versionId})`
}

function timestampToken(createdAt: string): string {
  return createdAt.replace(/[^0-9TZ]+/g, '')
}
