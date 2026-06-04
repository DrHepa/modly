export const ARTIFACT_KINDS = ['image', 'text', 'mesh'] as const
export const ARTIFACT_VERSION_ROLES = ['original', 'current', 'edited'] as const
export const ARTIFACT_SUBSTITUTION_STATUSES = ['declared', 'applied', 'rejected'] as const
export const ARTIFACT_REPLACEMENT_STATUSES = ['accepted', 'rejected', 'noop'] as const
export const ARTIFACT_REPLACEMENT_REASONS = [
  'no_replacement',
  'kind_not_allowed',
  'legacy_unavailable',
  'stale_checkpoint',
] as const

export type ArtifactKind = typeof ARTIFACT_KINDS[number]
export type ArtifactVersionRole = typeof ARTIFACT_VERSION_ROLES[number]
export type ArtifactSubstitutionStatus = typeof ARTIFACT_SUBSTITUTION_STATUSES[number]
export type ArtifactReplacementStatus = typeof ARTIFACT_REPLACEMENT_STATUSES[number]
export type ArtifactReplacementReason = typeof ARTIFACT_REPLACEMENT_REASONS[number]

export interface LegacyArtifactPayload {
  filePath?: string
  text?: string
  outputType?: ArtifactKind
}

export interface ArtifactProvenance {
  workflowId: string
  workflowNodeId: string
  extensionId?: string
  extensionNodeId?: string
}

export interface ArtifactRef {
  id: string
  kind: ArtifactKind
  uri?: string
  text?: string
  versionId: string
  legacy?: LegacyArtifactPayload
  provenance?: ArtifactProvenance
}

export interface ArtifactVersion {
  id: string
  role: ArtifactVersionRole
  ref: ArtifactRef
  createdAt: string
  parentVersionId?: string
}

export interface ArtifactSidecar {
  artifactId: string
  workspacePath: string
  metadata: Record<string, unknown>
}

export interface ArtifactLineage {
  artifactId: string
  originalVersionId: string
  currentVersionId: string
  versions: ArtifactVersion[]
}

export interface ArtifactSubstitution {
  nodeId: string
  inputArtifactId: string
  replacementArtifactId?: string
  allowedKinds: ArtifactKind[]
  status: ArtifactSubstitutionStatus
}

export interface ArtifactSubstitutionInteraction {
  boundary: 'ui_only'
  headless: false
  editor: 'none'
  continueMode: 'manual'
}

export interface ArtifactSubstitutionPoint extends ArtifactSubstitution {
  kind: 'artifact_substitution'
  inputArtifact: ArtifactRef
  interaction: ArtifactSubstitutionInteraction
}

export type ArtifactReplacementResult =
  | {
      status: 'accepted'
      artifact: ArtifactRef
      legacy: LegacyArtifactPayload
    }
  | {
      status: 'rejected'
      reason: Exclude<ArtifactReplacementReason, 'no_replacement'>
      artifact?: ArtifactRef
      legacy?: LegacyArtifactPayload
    }
  | {
      status: 'noop'
      reason: 'no_replacement'
      artifact?: ArtifactRef
      legacy?: LegacyArtifactPayload
    }

export interface WorkflowContinueOptions {
  replacementArtifact?: ArtifactRef
}
