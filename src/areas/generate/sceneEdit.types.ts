export type ScenePartType = 'node' | 'mesh' | 'skinned-mesh' | 'bone' | 'armature'

export type SceneEditGuardrail =
  | { status: 'allowed' }
  | {
      status: 'blocked'
      reason: 'skinned-mesh' | 'bone' | 'armature' | 'animation-dependency'
      message: string
    }

export interface ScenePart {
  id: string
  label: string
  type: ScenePartType
  path: string[]
  siblingIndex: number
  selectable: boolean
  guardrail: SceneEditGuardrail
}

export interface EditPlan {
  sourceArtifactId: string
  sourceVersionId?: string
  sourceWorkspacePath: string
  selectedPartId?: string
  excludedPartIds: string[]
}

export type EditPlanAction =
  | { type: 'select-part'; partId: string }
  | { type: 'exclude-selected-part' }
  | { type: 'exclude-part'; partId: string }
  | { type: 'unexclude-part'; partId: string }
  | { type: 'reset' }
  | { type: 'clear' }

export type SceneEditArtifactType = 'mesh' | 'image' | 'video' | 'other'

export interface SceneEditArtifactDescriptor {
  type: SceneEditArtifactType
  workspacePath: string
}

export type SceneEditEligibilityResult =
  | { eligible: true }
  | {
      eligible: false
      reason: 'not-checkpoint-preview' | 'not-mesh-artifact' | 'unsafe-workspace-path'
    }

export type SceneEditExportResult =
  | { success: true; bytes: Uint8Array }
  | { success: false; error: string }

export type WorkspaceArtifactWriteResult =
  | { success: true; workspacePath: string }
  | { success: false; error: string }

export type EditPlanExportability =
  | { exportable: true }
  | { exportable: false; blockedPartIds: string[] }

export interface SceneEditCloneIntent {
  operation: 'clone-scene-and-remove-excluded-parts'
  excludedPartIds: string[]
  materialHandling: 'restore-original-materials-before-export'
  exporter: 'GLTFExporter'
}

export interface SceneEditExcludedPartMetadata {
  id: string
  label: string
}

export interface SceneEditSidecarMetadata {
  kind: 'scene-edit'
  source: {
    artifactId: string
    versionId?: string
    workspacePath: string
  }
  excludedParts: SceneEditExcludedPartMetadata[]
  exporter: {
    intended: 'GLTFExporter'
    binary: true
  }
  createdAt: string
  lineageIntent: {
    type: 'wait-replacement'
    sourceArtifactId: string
    sourceVersionId?: string
  }
  actionCopy: {
    hideLabel: string
    exportLabel: string
    destructive: false
  }
  cloneIntent: SceneEditCloneIntent
}

export type SceneEditOutputPathResult =
  | { success: true; glbWorkspacePath: string; sidecarWorkspacePath: string }
  | { success: false; reason: 'unsafe-output-path' | 'source-overwrite'; message: string }

export interface SceneEditExportPlan {
  kind: 'scene-edit-export-plan'
  source: {
    artifactId: string
    versionId?: string
    workspacePath: string
  }
  output: {
    glbWorkspacePath: string
    sidecarWorkspacePath: string
  }
  excludedParts: SceneEditExcludedPartMetadata[]
  cloneIntent: SceneEditCloneIntent
  sidecar: SceneEditSidecarMetadata
}

export type SceneEditExportPlanResult =
  | { success: true; plan: SceneEditExportPlan }
  | {
      success: false
      reason: 'empty-exclusion-plan'
      message: string
    }
  | {
      success: false
      reason: 'unknown-part' | 'blocked-part'
      partIds: string[]
      message: string
    }
  | {
      success: false
      reason: 'unsafe-output-path' | 'source-overwrite'
      message: string
    }
