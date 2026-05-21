import { Mesh, Object3D } from 'three'

import { collectSceneParts } from './sceneEdit.ts'
import { buildSceneEditExportPlan } from './sceneEditExport.ts'
import type { ViewerModelSource } from './viewerModelSource.ts'
import { resolveCheckpointEditEligibility } from './viewerModelSource.ts'
import type { EditPlan, SceneEditArtifactDescriptor, ScenePart } from './sceneEdit.types.ts'
import { buildEditedCheckpointArtifactRef, type EditedCheckpointArtifactLineageIntent } from '../workflows/workflowArtifacts.ts'
import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult } from '../../shared/types/electron.d.ts'

export interface SceneEditSourceDescriptor {
  artifactId: string
  artifact: SceneEditArtifactDescriptor
}

export type SceneEditControlsVisibility =
  | { visible: true }
  | { visible: false; reason: 'not-checkpoint-preview' | 'not-mesh-artifact' | 'unsafe-workspace-path' | 'missing-source' }

export interface GLTFExporterLike {
  parse: (
    input: Object3D,
    onDone: (result: ArrayBuffer | object) => void,
    onError?: (error: Error | ErrorEvent) => void,
    options?: { binary: true },
  ) => void
}

export interface ExportEditedSceneArtifactInput {
  scene: Object3D
  parts: readonly ScenePart[]
  editPlan: EditPlan
  createdAt: string
  exporter: GLTFExporterLike
  writer: (request: EditedSceneArtifactWriteRequest) => Promise<EditedSceneArtifactWriteResult>
}

export type ExportEditedSceneArtifactResult = EditedSceneArtifactWriteResult | { success: false; error: string }

type ExportEditedSceneArtifactStage = 'planning' | 'export' | 'write'

type StagedExportEditedSceneArtifactResult =
  | Extract<EditedSceneArtifactWriteResult, { success: true }>
  | { success: false; stage: ExportEditedSceneArtifactStage; error: string }

export type SceneEditArtifactRegistrationResult =
  | { success: true; artifact: ArtifactRef; lineageIntent: EditedCheckpointArtifactLineageIntent }
  | { success: false; error: string }

export interface SaveEditedScenePendingReplacementInput extends ExportEditedSceneArtifactInput {
  sourceArtifact: ArtifactRef
  setPendingReplacement: (artifact: ArtifactRef) => void
  registerEditedArtifact?: (input: {
    sourceArtifact: ArtifactRef
    glbWorkspacePath: string
    sidecarWorkspacePath: string
    createdAt: string
    metadata: Record<string, unknown>
  }) => SceneEditArtifactRegistrationResult
}

export type SaveEditedScenePendingReplacementResult =
  | {
      success: true
      status: 'pending-replacement-set'
      artifact: ArtifactRef
      lineageIntent: EditedCheckpointArtifactLineageIntent
      glbWorkspacePath: string
      sidecarWorkspacePath: string
    }
  | { success: false; stage: ExportEditedSceneArtifactStage | 'registration'; error: string }

export function resolveSceneEditSourceDescriptor(input: {
  currentJobId: string | undefined
  modelSource: ViewerModelSource
}): SceneEditSourceDescriptor | null {
  if (input.modelSource.kind !== 'workflow-checkpoint') return null
  if (!input.currentJobId) return null

  const workspacePath = extractWorkspacePath(input.modelSource.modelUrl)
  if (!workspacePath) return null

  return {
    artifactId: input.currentJobId,
    artifact: {
      type: isMeshWorkspacePath(workspacePath) ? 'mesh' : 'other',
      workspacePath,
    },
  }
}

export function resolveSceneEditControlsVisibility(input: {
  modelSource: ViewerModelSource
  source: SceneEditArtifactDescriptor | null
}): SceneEditControlsVisibility {
  if (!input.source) return { visible: false, reason: 'missing-source' }

  const eligibility = resolveCheckpointEditEligibility({ modelSource: input.modelSource, artifact: input.source })
  if (!eligibility.eligible) {
    return { visible: false, reason: eligibility.reason }
  }

  return { visible: true }
}

export function resolveScenePartIdForObject(input: {
  scene: Object3D
  target: Object3D
  parts: readonly ScenePart[]
}): string | null {
  const targetId = collectScenePartsWithObjects(input.scene).find((entry) => entry.object === input.target)?.part.id
  if (!targetId) return null

  const existingPart = input.parts.find((part) => part.id === targetId)
  return existingPart?.selectable ? existingPart.id : null
}

export async function exportEditedSceneArtifact(input: ExportEditedSceneArtifactInput): Promise<ExportEditedSceneArtifactResult> {
  const result = await exportEditedSceneArtifactWithStage(input)
  if (!result.success) return { success: false, error: result.error }
  return result
}

export async function saveEditedScenePendingReplacement(
  input: SaveEditedScenePendingReplacementInput,
): Promise<SaveEditedScenePendingReplacementResult> {
  const exportResult = await exportEditedSceneArtifactWithStage(input)
  if (!exportResult.success) return exportResult

  const registration = (input.registerEditedArtifact ?? registerEditedCheckpointArtifact)({
    sourceArtifact: input.sourceArtifact,
    glbWorkspacePath: exportResult.glbWorkspacePath,
    sidecarWorkspacePath: exportResult.sidecarWorkspacePath,
    createdAt: input.createdAt,
    metadata: exportResult.metadata,
  })
  if (!registration.success) {
    return { success: false, stage: 'registration', error: registration.error }
  }

  input.setPendingReplacement(registration.artifact)
  return {
    success: true,
    status: 'pending-replacement-set',
    artifact: registration.artifact,
    lineageIntent: registration.lineageIntent,
    glbWorkspacePath: exportResult.glbWorkspacePath,
    sidecarWorkspacePath: exportResult.sidecarWorkspacePath,
  }
}

function registerEditedCheckpointArtifact(input: {
  sourceArtifact: ArtifactRef
  glbWorkspacePath: string
  sidecarWorkspacePath: string
  createdAt: string
  metadata: Record<string, unknown>
}): SceneEditArtifactRegistrationResult {
  try {
    return {
      success: true,
      ...buildEditedCheckpointArtifactRef(input.sourceArtifact, {
        workspacePath: input.glbWorkspacePath,
        sidecarWorkspacePath: input.sidecarWorkspacePath,
        createdAt: input.createdAt,
      }),
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Edited artifact registration failed.' }
  }
}

async function exportEditedSceneArtifactWithStage(input: ExportEditedSceneArtifactInput): Promise<StagedExportEditedSceneArtifactResult> {
  const exportPlan = buildSceneEditExportPlan({
    editPlan: input.editPlan,
    parts: input.parts,
    createdAt: input.createdAt,
  })
  if (!exportPlan.success) {
    return { success: false, stage: 'planning', error: exportPlan.message }
  }

  const clone = input.scene.clone(true)
  restoreOriginalMaterials(clone)
  removeExcludedPartsFromClone(clone, exportPlan.plan.cloneIntent.excludedPartIds)

  const exportResult = await exportCloneAsBinary(input.exporter, clone)
  if (!exportResult.success) return { ...exportResult, stage: 'export' }

  const writeResult = await input.writer({
    glbWorkspacePath: exportPlan.plan.output.glbWorkspacePath,
    sidecarWorkspacePath: exportPlan.plan.output.sidecarWorkspacePath,
    sourceWorkspacePath: exportPlan.plan.source.workspacePath,
    bytes: exportResult.bytes,
    metadata: exportPlan.plan.sidecar as unknown as Record<string, unknown>,
  })
  if (!writeResult.success) return { success: false, stage: 'write', error: writeResult.error }
  return writeResult
}

function extractWorkspacePath(modelUrl: string): string | null {
  const marker = '/workspace/'
  const markerIndex = modelUrl.indexOf(marker)
  if (markerIndex < 0) return null

  const workspacePath = decodeURIComponent(modelUrl.slice(markerIndex + marker.length)).replace(/\?.*$/, '').replace(/#.*$/, '')
  if (!workspacePath || workspacePath.startsWith('/') || workspacePath.split('/').includes('..')) return null
  return workspacePath
}

function isMeshWorkspacePath(workspacePath: string): boolean {
  const lower = workspacePath.toLowerCase()
  return lower.endsWith('.glb') || lower.endsWith('.gltf')
}

function restoreOriginalMaterials(scene: Object3D): void {
  scene.traverse((node) => {
    if (!(node instanceof Mesh)) return
    const originalMaterial = node.userData.originalMaterial
    if (originalMaterial) {
      node.material = originalMaterial
    }
  })
}

function removeExcludedPartsFromClone(clone: Object3D, excludedPartIds: readonly string[]): void {
  const excluded = new Set(excludedPartIds)
  const cloneParts = collectScenePartsWithObjects(clone)
  for (const { part, object } of cloneParts) {
    if (!excluded.has(part.id)) continue
    object.parent?.remove(object)
  }
}

function collectScenePartsWithObjects(scene: Object3D): { part: ScenePart; object: Object3D }[] {
  const parts = collectSceneParts(scene)
  const objects: Object3D[] = []
  scene.traverse((node) => {
    if (node !== scene) objects.push(node)
  })

  return parts.map((part, index) => ({ part, object: objects[index] })).filter((entry) => entry.object !== undefined)
}

function exportCloneAsBinary(exporter: GLTFExporterLike, clone: Object3D): Promise<{ success: true; bytes: Uint8Array } | { success: false; error: string }> {
  return new Promise((resolve) => {
    try {
      exporter.parse(
        clone,
        (result) => {
          if (result instanceof ArrayBuffer) {
            resolve({ success: true, bytes: new Uint8Array(result) })
            return
          }
          resolve({ success: false, error: 'GLTFExporter returned non-binary output.' })
        },
        (error) => resolve({ success: false, error: error instanceof Error ? error.message : error.message || 'GLTFExporter failed.' }),
        { binary: true },
      )
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : 'GLTFExporter failed.' })
    }
  })
}
