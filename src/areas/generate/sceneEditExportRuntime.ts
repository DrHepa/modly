import { AnimationClip, Bone, BufferGeometry, Group, Material, Matrix4, Mesh, Object3D, Scene, Skeleton, SkinnedMesh, Source, Texture } from 'three'

import { collectSceneAnimations, collectSceneParts, resolveSceneAnimationTarget } from './sceneEdit.ts'
import { buildSceneEditExportPlan } from './sceneEditExport.ts'
import type { ViewerModelSource } from './viewerModelSource.ts'
import { normalizeSceneWorkspacePath, resolveCheckpointEditEligibility } from './viewerModelSource.ts'
import type { EditPlan, SceneEditArtifactDescriptor, ScenePart } from './sceneEdit.types.ts'
import { buildEditedCheckpointArtifactRef, type EditedCheckpointArtifactLineageIntent, type CheckpointOwner } from '../workflows/workflowArtifacts.ts'
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
    onError: (error: Error | ErrorEvent) => void,
    options?: { binary: true; animations: AnimationClip[]; onlyVisible: false },
  ) => void | Promise<void>
}

export interface ExportEditedSceneArtifactInput {
  scene: Object3D
  parts: readonly ScenePart[]
  animationClips?: readonly AnimationClip[]
  /** Supply closure-owned originals if the source currently has display overlays. Never use serialized userData. */
  originalMaterials?: ReadonlyMap<Mesh, Material | Material[]>
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
  /** Required to bind absolute runtime artifact paths; never persisted in export metadata. */
  workspaceDir?: string
  checkpointNodeId: string
  getCheckpointOwner: (nodeId: string) => CheckpointOwner | undefined
  setPendingReplacement: (owner: CheckpointOwner, artifact: ArtifactRef) => boolean
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
      status: 'pending-replacement-set' | 'saved-unselected'
      artifact: ArtifactRef
      lineageIntent: EditedCheckpointArtifactLineageIntent
      glbWorkspacePath: string
      sidecarWorkspacePath: string
    }
  | { success: false; stage: ExportEditedSceneArtifactStage | 'registration' | 'ownership'; error: string }

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
  const targetPart = collectScenePartsWithObjects(input.scene).find(entry => entry.object === input.target)?.part
  if (!targetPart?.selectable) return null
  const targetId = targetPart.id

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
  // Capture values, not mutable projections, before either asynchronous boundary.
  const currentOwner = input.getCheckpointOwner(input.checkpointNodeId)
  const owner = currentOwner ? { ...currentOwner } : undefined
  const sourceArtifact = { ...input.sourceArtifact, ...(input.sourceArtifact.legacy ? { legacy: { ...input.sourceArtifact.legacy } } : {}) }
  const sourcePath = normalizeSceneWorkspacePath(input.editPlan.sourceWorkspacePath)
  const artifactPaths = [sourceArtifact.uri, sourceArtifact.legacy?.filePath].filter((path): path is string => path !== undefined)
    .map(path => sourceArtifactWorkspacePath(path, input.workspaceDir))
  if (!owner || owner.nodeId !== input.checkpointNodeId || owner.inputArtifactId !== sourceArtifact.id
    || owner.inputVersionId !== sourceArtifact.versionId || sourceArtifact.kind !== 'mesh'
    || input.editPlan.sourceArtifactId !== sourceArtifact.id || input.editPlan.sourceVersionId !== sourceArtifact.versionId
    || !sourcePath || artifactPaths.length === 0 || artifactPaths.some(path => path !== sourcePath)) {
    return { success: false, stage: 'ownership', error: 'The edit source does not match the captured checkpoint owner.' }
  }
  const createdAt = input.createdAt
  const register = input.registerEditedArtifact ?? registerEditedCheckpointArtifact
  const publish = input.setPendingReplacement
  const exportResult = await exportEditedSceneArtifactWithStage(input)
  if (!exportResult.success) return exportResult

  try {
    const registration = register({
      sourceArtifact,
      glbWorkspacePath: exportResult.glbWorkspacePath,
      sidecarWorkspacePath: exportResult.sidecarWorkspacePath,
      createdAt,
      metadata: exportResult.metadata,
    })
    if (!registration.success) return { success: false, stage: 'registration', error: registration.error }
    // A rejected compare-and-set leaves real saved files unselected. Never acquire a newer owner here.
    const selected = publish(owner, registration.artifact)
    return {
      success: true,
      status: selected ? 'pending-replacement-set' : 'saved-unselected',
      artifact: registration.artifact,
      lineageIntent: registration.lineageIntent,
      glbWorkspacePath: exportResult.glbWorkspacePath,
      sidecarWorkspacePath: exportResult.sidecarWorkspacePath,
    }
  } catch (error) {
    return { success: false, stage: 'registration', error: errorMessage(error, 'Edited artifact registration failed.') }
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
  const writer = input.writer
  // Caller UI lists are not permission to delete actual rig/animation dependencies.
  const actualParts = collectSceneParts(input.scene, { animationClips: input.animationClips })
  const suppliedParts = new Map(input.parts.map(part => [part.id, part]))
  const parts = actualParts.map(part => {
    const supplied = suppliedParts.get(part.id)
    return supplied?.guardrail.status === 'blocked' ? { ...part, guardrail: supplied.guardrail, selectable: false } : part
  })
  const exportPlan = buildSceneEditExportPlan({ editPlan: input.editPlan, parts, createdAt: input.createdAt })
  if (!exportPlan.success) return { success: false, stage: 'planning', error: exportPlan.message }

  let owned: ReturnType<typeof cloneSceneForExport> | undefined
  try {
    owned = cloneSceneForExport(input.scene, input.originalMaterials)
    const clips = cloneExportAnimations(input.scene, owned.objects, input.animationClips)
    const objects = collectScenePartsWithObjects(input.scene)
    for (const { part, object } of objects) {
      if (exportPlan.plan.cloneIntent.excludedPartIds.includes(part.id)) owned.objects.get(object)?.removeFromParent()
    }
    prepareCloneForTrsExport(owned.scene)
    const exportResult = await exportCloneAsBinary(input.exporter, owned.scene, clips)
    if (!exportResult.success) return { ...exportResult, stage: 'export' }
    try {
      const writeResult = await writer({
        glbWorkspacePath: exportPlan.plan.output.glbWorkspacePath,
        sidecarWorkspacePath: exportPlan.plan.output.sidecarWorkspacePath,
        sourceWorkspacePath: exportPlan.plan.source.workspacePath,
        bytes: exportResult.bytes,
        metadata: exportPlan.plan.sidecar as unknown as Record<string, unknown>,
      })
      if (!writeResult.success) return { success: false, stage: 'write', error: writeResult.error }
      // Main writer returns canonical workspace paths. Do not persist an unexpected absolute/mismatched ref.
      if (writeResult.glbWorkspacePath !== exportPlan.plan.output.glbWorkspacePath
        || writeResult.sidecarWorkspacePath !== exportPlan.plan.output.sidecarWorkspacePath) {
        return { success: false, stage: 'write', error: 'Edited artifact writer returned mismatched workspace paths.' }
      }
      return writeResult
    } catch (error) {
      return { success: false, stage: 'write', error: errorMessage(error, 'Edited artifact write failed.') }
    }
  } catch (error) {
    return { success: false, stage: 'export', error: errorMessage(error, 'Edited scene clone failed.') }
  } finally {
    owned?.dispose()
  }
}

function sourceArtifactWorkspacePath(path: string, workspaceDir?: string): string | null {
  const relative = normalizeSceneWorkspacePath(path)
  if (relative) return relative
  if (!workspaceDir) return null
  const root = workspaceDir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = path.replace(/\\/g, '/')
  return root && absolute.startsWith(`${root}/`) ? normalizeSceneWorkspacePath(absolute.slice(root.length + 1)) : null
}

function extractWorkspacePath(modelUrl: string): string | null {
  try {
    // Parse the path before decoding, so encoded #/? inside filenames are not truncated.
    if (!modelUrl.startsWith('/') && !/^https?:\/\//.test(modelUrl)) return null
    const path = modelUrl.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/, 1)[0]
    if (!path.startsWith('/workspace/')) return null
    return normalizeSceneWorkspacePath(decodeURIComponent(path.slice('/workspace/'.length)))
  } catch {
    return null
  }
}

function isMeshWorkspacePath(workspacePath: string): boolean {
  const lower = workspacePath.toLowerCase()
  return lower.endsWith('.glb') || lower.endsWith('.gltf')
}

/** Own every mutable export resource; source pixels are read-only, never disposed here. */
function cloneSceneForExport(source: Object3D, originals?: ReadonlyMap<Mesh, Material | Material[]>): {
  scene: Object3D
  objects: Map<Object3D, Object3D>
  dispose: () => void
} {
  const objects = new Map<Object3D, Object3D>()
  const geometries = new Map<BufferGeometry, BufferGeometry>()
  const materials = new Map<Material, Material>()
  const textures = new Map<Texture, Texture>()
  const skeletons: Skeleton[] = []
  const dispose = () => {
    for (const geometry of geometries.values()) geometry.dispose()
    for (const material of materials.values()) material.dispose()
    for (const texture of textures.values()) texture.dispose()
    for (const skeleton of skeletons) skeleton.dispose()
  }
  try {
    // GLTFExporter emits Scene children without the Scene transform. Keep the
    // supplied root as a normal node, including its animation/skeleton mapping.
    const scene = source instanceof Scene ? new Group().copy(source, true) : source.clone(true)
    function mapTree(original: Object3D, clone: Object3D): void {
      objects.set(original, clone)
      // These may contain serialized Material JSON. They are not authoritative resources.
      delete clone.userData.originalMaterial
      clone.animations = []
      original.children.forEach((child, index) => mapTree(child, clone.children[index]))
    }
    mapTree(source, scene)
    function cloneMaterial(original: Material): Material {
      if (!(original instanceof Material)) throw new Error('Original materials must be live Three.js Material instances.')
      const existing = materials.get(original)
      if (existing) return existing
      const clone = original.clone(); materials.set(original, clone)
      for (const [key, value] of Object.entries(original)) {
        if (!(value instanceof Texture)) continue
        let texture = textures.get(value)
        if (!texture) {
          // Texture.copy marks its Source dirty; isolate Source BEFORE copy, not afterwards.
          const descriptor: Texture = Object.create(value)
          descriptor.source = new Source(value.source.data)
          texture = value.clone.call(descriptor)
          textures.set(value, texture)
        }
        Object.assign(clone, { [key]: texture })
      }
      return clone
    }
    for (const [original, clone] of objects) {
      if (!(original instanceof Mesh) || !(clone instanceof Mesh)) continue
      let geometry = geometries.get(original.geometry)
      if (!geometry) { const created: BufferGeometry = original.geometry.clone(); geometries.set(original.geometry, created); geometry = created }
      clone.geometry = geometry
      const material = originals?.get(original) ?? original.material
      clone.material = Array.isArray(material) ? material.map(cloneMaterial) : cloneMaterial(material)
      if (original instanceof SkinnedMesh && clone instanceof SkinnedMesh) {
        if (!original.skeleton) throw new Error('Skinned mesh is missing its skeleton.')
        const bones = original.skeleton.bones.map(bone => {
          const mapped = objects.get(bone)
          if (!(mapped instanceof Bone)) throw new Error('Skeleton bone is outside the exported source hierarchy.')
          return mapped
        })
        const skeleton = new Skeleton(bones, original.skeleton.boneInverses.map(matrix => matrix.clone()))
        skeletons.push(skeleton)
        clone.skeleton = skeleton
        clone.bindMatrix.copy(original.bindMatrix)
        clone.bindMatrixInverse.copy(original.bindMatrixInverse)
      }
    }
    return { scene, objects, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

/** glTF requires TRS-decomposable local matrices even without animation. */
function prepareCloneForTrsExport(scene: Object3D): void {
  const reconstructed = new Matrix4()
  scene.traverse(node => {
    if (node.matrixAutoUpdate) return
    // matrix is authoritative here; source position/quaternion/scale may be stale.
    node.matrix.decompose(node.position, node.quaternion, node.scale)
    reconstructed.compose(node.position, node.quaternion, node.scale)
    const representable = node.matrix.elements.every((value, index) => Number.isFinite(value)
      && Number.isFinite(reconstructed.elements[index])
      && Math.abs(value - reconstructed.elements[index]) <= 1e-7 * Math.max(1, Math.abs(value)))
    if (!representable) {
      throw new Error(`Cannot preserve manual matrix as TRS for GLB export: ${node.name || node.type}.`)
    }
  })
}

function cloneExportAnimations(source: Object3D, objects: ReadonlyMap<Object3D, Object3D>, clips?: readonly AnimationClip[]): AnimationClip[] {
  return collectSceneAnimations(source, clips).map(({ root, clip }) => {
    const copy = clip.clone()
    copy.tracks.forEach((track, index) => {
      const { node, binding } = resolveSceneAnimationTarget(root, clip.tracks[index].name)
      const target = objects.get(node)
      if (!target || !['position', 'quaternion', 'scale', 'morphTargetInfluences'].includes(binding.propertyName)
        || (binding.objectName && binding.objectName !== 'bones')
        || (binding.propertyIndex !== undefined && binding.propertyName !== 'morphTargetInfluences')) {
        throw new Error(`Unsupported GLB animation binding: ${track.name}`)
      }
      // UUID rebinding avoids duplicate names and never changes source clips or node names.
      track.name = `${target.uuid}.${binding.propertyName}${binding.propertyIndex !== undefined ? `[${binding.propertyIndex}]` : ''}`
    })
    return copy
  })
}

function collectScenePartsWithObjects(scene: Object3D): { part: ScenePart; object: Object3D }[] {
  const parts = collectSceneParts(scene)
  const objects: Object3D[] = []
  scene.traverse(node => { if (node !== scene) objects.push(node) })
  return parts.map((part, index) => ({ part, object: objects[index] }))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function exportCloneAsBinary(exporter: GLTFExporterLike, clone: Object3D, animations: AnimationClip[]): Promise<{ success: true; bytes: Uint8Array } | { success: false; error: string }> {
  return new Promise(resolve => {
    const fail = (error: unknown) => resolve({ success: false, error: errorMessage(error, 'GLTFExporter failed.') })
    try {
      const pending = exporter.parse(
        clone,
        result => {
          if (result instanceof ArrayBuffer && result.byteLength > 0) resolve({ success: true, bytes: new Uint8Array(result) })
          else resolve({ success: false, error: 'GLTFExporter returned non-binary output.' })
        },
        fail,
        { binary: true, animations, onlyVisible: false },
      )
      if (pending) void Promise.resolve(pending).catch(fail)
    } catch (error) {
      fail(error)
    }
  })
}
