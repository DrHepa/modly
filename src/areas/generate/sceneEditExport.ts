import { SCENE_EDIT_ACTION_LABELS, isEditPlanExportable } from './sceneEdit.ts'
import type {
  EditPlan,
  SceneEditCloneIntent,
  SceneEditExcludedPartMetadata,
  SceneEditExportPlanResult,
  SceneEditOutputPathResult,
  SceneEditSidecarMetadata,
  ScenePart,
} from './sceneEdit.types.ts'

export interface BuildSceneEditOutputPathsInput {
  sourceWorkspacePath: string
  sourceArtifactId: string
  createdAt: string
  requestedOutputWorkspacePath?: string
}

export interface BuildSceneEditSidecarMetadataInput {
  editPlan: EditPlan
  excludedParts: readonly ScenePart[]
  createdAt: string
}

export interface BuildSceneEditExportPlanInput {
  editPlan: EditPlan
  parts: readonly ScenePart[]
  createdAt: string
  requestedOutputWorkspacePath?: string
}

const EDITED_EXPORT_PREFIX = 'Workflows/edited/'

export function buildSceneEditExportPlan(input: BuildSceneEditExportPlanInput): SceneEditExportPlanResult {
  if (input.editPlan.excludedPartIds.length === 0) {
    return {
      success: false,
      reason: 'empty-exclusion-plan',
      message: 'At least one excluded part is required to export an edited copy.',
    }
  }

  const partsById = new Map(input.parts.map((part) => [part.id, part]))
  const unknownPartIds = input.editPlan.excludedPartIds.filter((partId) => !partsById.has(partId))
  if (unknownPartIds.length > 0) {
    return {
      success: false,
      reason: 'unknown-part',
      partIds: unknownPartIds,
      message: 'Excluded parts must exist in the collected scene parts.',
    }
  }

  const exportability = isEditPlanExportable(input.editPlan, input.parts)
  if (!exportability.exportable) {
    return {
      success: false,
      reason: 'blocked-part',
      partIds: exportability.blockedPartIds,
      message: 'Blocked guardrail parts cannot be excluded from an edited export.',
    }
  }

  const outputPaths = buildSceneEditOutputPaths({
    sourceWorkspacePath: input.editPlan.sourceWorkspacePath,
    sourceArtifactId: input.editPlan.sourceArtifactId,
    createdAt: input.createdAt,
    requestedOutputWorkspacePath: input.requestedOutputWorkspacePath,
  })
  if (!outputPaths.success) {
    return outputPaths
  }

  const excludedParts = input.editPlan.excludedPartIds.map((partId) => partsById.get(partId)).filter(isScenePart)
  const sidecar = buildSceneEditSidecarMetadata({
    editPlan: input.editPlan,
    excludedParts,
    createdAt: input.createdAt,
  })

  return {
    success: true,
    plan: {
      kind: 'scene-edit-export-plan',
      source: {
        artifactId: input.editPlan.sourceArtifactId,
        ...(input.editPlan.sourceVersionId !== undefined ? { versionId: input.editPlan.sourceVersionId } : {}),
        workspacePath: input.editPlan.sourceWorkspacePath,
      },
      output: {
        glbWorkspacePath: outputPaths.glbWorkspacePath,
        sidecarWorkspacePath: outputPaths.sidecarWorkspacePath,
      },
      excludedParts: sidecar.excludedParts,
      cloneIntent: sidecar.cloneIntent,
      sidecar,
    },
  }
}

export function buildSceneEditOutputPaths(input: BuildSceneEditOutputPathsInput): SceneEditOutputPathResult {
  const sourcePath = normalizeWorkspacePath(input.sourceWorkspacePath)
  const requestedPath = input.requestedOutputWorkspacePath?.trim()
  const glbWorkspacePath = requestedPath && requestedPath.length > 0
    ? normalizeWorkspacePath(requestedPath)
    : `${EDITED_EXPORT_PREFIX}${buildOutputStem(input)}.glb`

  if (glbWorkspacePath === sourcePath) {
    return {
      success: false,
      reason: 'source-overwrite',
      message: 'Edited export path must not overwrite the source artifact.',
    }
  }

  if (!isSafeEditedGlbPath(glbWorkspacePath)) {
    return {
      success: false,
      reason: 'unsafe-output-path',
      message: 'Edited export path must be workspace-relative under Workflows/edited/.',
    }
  }

  return {
    success: true,
    glbWorkspacePath,
    sidecarWorkspacePath: `${glbWorkspacePath.slice(0, -'.glb'.length)}.json`,
  }
}

export function buildSceneEditSidecarMetadata(input: BuildSceneEditSidecarMetadataInput): SceneEditSidecarMetadata {
  const excludedParts = input.excludedParts.map(toExcludedPartMetadata)
  const cloneIntent = buildCloneIntent(excludedParts.map((part) => part.id))

  return {
    kind: 'scene-edit',
    source: {
      artifactId: input.editPlan.sourceArtifactId,
      ...(input.editPlan.sourceVersionId !== undefined ? { versionId: input.editPlan.sourceVersionId } : {}),
      workspacePath: input.editPlan.sourceWorkspacePath,
    },
    excludedParts,
    exporter: { intended: 'GLTFExporter', binary: true },
    createdAt: input.createdAt,
    lineageIntent: {
      type: 'wait-replacement',
      sourceArtifactId: input.editPlan.sourceArtifactId,
      ...(input.editPlan.sourceVersionId !== undefined ? { sourceVersionId: input.editPlan.sourceVersionId } : {}),
    },
    actionCopy: {
      hideLabel: SCENE_EDIT_ACTION_LABELS.hideFromEditedCopy,
      exportLabel: SCENE_EDIT_ACTION_LABELS.excludeFromExport,
      destructive: false,
    },
    cloneIntent,
  }
}

function buildCloneIntent(excludedPartIds: string[]): SceneEditCloneIntent {
  return {
    operation: 'clone-scene-and-remove-excluded-parts',
    excludedPartIds,
    materialHandling: 'restore-original-materials-before-export',
    exporter: 'GLTFExporter',
  }
}

function toExcludedPartMetadata(part: ScenePart): SceneEditExcludedPartMetadata {
  return { id: part.id, label: part.label }
}

function buildOutputStem(input: BuildSceneEditOutputPathsInput): string {
  const sourceBaseName = basenameWithoutExtension(input.sourceWorkspacePath)
  return `${sanitizePathToken(sourceBaseName)}-edited-${sanitizePathToken(input.sourceArtifactId)}-${timestampToken(input.createdAt)}`
}

function basenameWithoutExtension(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath)
  const fileName = normalized.split('/').at(-1) ?? 'artifact'
  return fileName.replace(/\.[^.]+$/, '') || 'artifact'
}

function timestampToken(createdAt: string): string {
  return createdAt.replace(/[^0-9TZ]+/g, '')
}

function sanitizePathToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'artifact'
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\+/g, '/')
}

function isSafeEditedGlbPath(workspacePath: string): boolean {
  return workspacePath.startsWith(EDITED_EXPORT_PREFIX)
    && workspacePath.endsWith('.glb')
    && !isAbsolutePath(workspacePath)
    && !workspacePath.split('/').includes('..')
    && workspacePath.length > EDITED_EXPORT_PREFIX.length + '.glb'.length
}

function isAbsolutePath(workspacePath: string): boolean {
  return workspacePath.startsWith('/') || /^[A-Za-z]:\//.test(workspacePath)
}

function isScenePart(value: ScenePart | undefined): value is ScenePart {
  return value !== undefined
}
