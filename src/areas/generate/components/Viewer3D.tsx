import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, ErrorInfo, MutableRefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Environment, GizmoHelper, Html, Lightformer, OrbitControls, useGizmoContext, useGLTF } from '@react-three/drei'
import { EffectComposer, Outline, Select, Selection } from '@react-three/postprocessing'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

// Patch THREE pour utiliser BVH sur tous les meshes — réduit le raycast O(N) → O(log N)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast
import SplatViewer, { type SplatViewerHandle } from './SplatViewer'
import { useGeneration } from '@shared/hooks/useGeneration'
import { useAppStore, DEFAULT_LIGHT_SETTINGS } from '@shared/stores/appStore'
import type { LightSettings, PointLight } from '@shared/stores/appStore'
import { ViewerEditToolbar, ViewerViewToolbar, type ViewMode } from './ViewerToolbar'
import type { MotionRetargetArtifactLink } from './MotionRetargetPanel'
import { RigEditorPanel, type RigEditorHumanoidReviewProps } from './RigEditorPanel'
import { RigOverlay } from './RigOverlay'
import { createLandmarkPointIntent, deriveLandmarkMarkers, resolveLandmarkMarkerRenderModels, type LandmarkMarkerViewModel } from './viewerLandmarkPicking'
import { isolateAnimationForPoseClipPreview, resetAnimationPlayback, resolveAnimationAvailability, syncAnimationActions, type AnimationActionLike, type AnimationIsolationSnapshot, type AnimationMixerLike, type AnimationPlaybackResetResult } from './viewerAnimation'
import { PoseClipPanel, type PoseClipDrawerMode, type PoseClipLoadState, type PoseClipPanelWarning, type PoseClipPreviewState, type PoseClipSaveState } from './PoseClipPanel'
import { normalizeSceneWorkspacePath, resolveViewerModelSource, type ViewerModelSource } from '../viewerModelSource'
import { resolveViewerAssetTarget, resolveViewerAssetWorkspacePathFromUrl, resolveViewerArtifactWorkspacePath, resolveViewerWorkspacePathFromAbsoluteValue, isSafeViewerWorkspaceRelativePath, type ViewerAssetTarget } from '../viewerAssetTarget.ts'
import { resolveViewerRigSourceWorkspacePath, resolveViewerTargetPresentation } from '../viewerProvenance.ts'
import { captureViewerWorkspaceArtifactService } from '../viewerWorkspaceArtifactService.ts'
import { collectSceneParts, createEditPlan, editPlanReducer } from '../sceneEdit'
import type { EditPlan, ScenePart } from '../sceneEdit.types'
import { buildRigSelectionOverlay, collectRigSkeletonBinding, type RigBoneId, type RigSelectionOverlayViewModel, type RigSkeletonSummary, type RigSkinnedMeshContext } from '../rigSkeleton.ts'
import { buildRigRenameSidecarV1, createRigRenamePlan, createRigRenameSidecarWorkspacePath, hydrateRigRenamePlanFromSidecar, reduceRigRenamePlan, validateRigRenamePlan, type RigRenamePlan, type RigRenameValidationResult } from '../rigRenamePlan.ts'
import { buildPoseClipSidecarV1, clampPoseClipTime, createLegacyPoseClipSidecarWorkspacePath, createPoseClipCaptureKeyframeId, createPoseClipPlan, createPoseClipSidecarWorkspacePath, deriveKimodoPoseClipCompanionV1, validatePoseClipSidecarWorkspacePath, hydratePoseClipPlanFromSidecar, reducePoseClipPlan, type PoseClipPlan, type PoseClipQuaternion, type PoseClipSidecarV1 } from '../poseClipPlan.ts'
import { createPoseClipPreviewSession, evaluatePoseClipPreviewSession, restorePoseClipPreviewSession, type PoseClipPreviewSession, applyLocalPoseClipRotation, evaluatePoseClipPreview, resetPoseClipPreview, resetPoseClipSelectedBone, restoreThenEvaluatePoseClipPreview, takePoseClipQuaternionSnapshot, type ApplyLocalPoseClipRotationResult, type EvaluatePoseClipPreviewResult, type PoseClipQuaternionSnapshot, type PoseClipRotationAxis } from '../poseClipPreview.ts'
import { DEFAULT_MOTION_RETARGET_CORRECTIONS, createMotionRetargetCorrectionIdentity, createMotionRetargetSession, createMotionRetargetSidecarV1, hydrateMotionRetargetSessionSnapshotFromSidecar, normalizeMotionRetargetCorrections, reduceMotionRetargetSession, resolveMotionRetargetCorrectionState, type MotionRetargetCorrectionIdentityV1, type MotionRetargetCorrectionsV1, type MotionRetargetMappingEntry, type MotionRetargetPreviewKind, type MotionRetargetSession, type MotionRetargetSourceBone } from '../motionRetargetPlan.ts'
import { normalizeKimodoMotionArtifact, type KimodoMotionArtifact } from '../kimodoMotionAdapter.ts'
import { resolveMotionRetargetPreviewClip, resetMotionRetargetPreview, restoreThenEvaluateMotionRetargetPreview, takeMotionRetargetPreviewSnapshot, type MotionRetargetTransformSnapshot } from '../motionRetargetPreview.ts'
import { resolveRigDisplayNames, type RigDisplayNamingResult } from '../rigDisplayNames.ts'
import { createRigMetaNamingFromHumanoidAssignments, normalizeRigMetaNaming, translateHumanoidAssignmentsToRigMetaNaming, type RigMetaNamingMap } from '../rigMetaNaming.ts'
import { resolveRigEffectiveNaming, type RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'
import {
  saveEditedScenePendingReplacement,
  resolveScenePartIdForObject,
} from '../sceneEditExportRuntime'
import { sameCheckpointOwner, type CheckpointOwner } from '../../workflows/workflowArtifacts'
import type { ArtifactRef } from '../../../shared/types/artifacts'
import { useWorkflowRunStore } from '../../workflows/workflowRunStore'
import type { LandmarkId, LandmarkPoint } from '../../workflows/landmarks'
import type { HumanoidDraftSidecarReadRequest, HumanoidDraftSidecarReadResult, HumanoidDraftSidecarV1, HumanoidPromotionMethod, HumanoidPromotionSidecarReadRequest, HumanoidPromotionSidecarReadResult, HumanoidPromotionSidecarV1, HumanoidPromotionSidecarWriteRequest, HumanoidPromotionSidecarWriteResult, MotionRetargetSidecarReadRequest, MotionRetargetSidecarReadResult, MotionRetargetSidecarWriteRequest, MotionRetargetSidecarWriteResult, WorkspaceArtifactDownloadRequest, WorkspaceArtifactDownloadResult, WorkspaceArtifactPreviewRequest, WorkspaceArtifactPreviewResult, PoseClipSidecarReadRequest, PoseClipSidecarReadResult, PoseClipSidecarWriteRequest, PoseClipSidecarWriteResult, RigMetaSidecarReadRequest, RigMetaSidecarReadResult, RigRenameSidecarReadRequest, RigRenameSidecarReadResult, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult } from '../../../shared/types/electron.d'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

// Drei Hud with priority 1 renders the default scene first, then the gizmo HUD.
export const VIEWER3D_VIEWPORT_GIZMO_RENDER_PRIORITY = 1
export const VIEWER3D_SELECTION_OUTLINE_RENDER_PRIORITY = 1

export function resolveViewer3DViewportGizmoRenderPriority(hasPostProcessing: boolean): number {
  // Hud priority 1 clears and redraws the base scene; an active composer owns it instead.
  return hasPostProcessing
    ? VIEWER3D_SELECTION_OUTLINE_RENDER_PRIORITY + 1
    : VIEWER3D_VIEWPORT_GIZMO_RENDER_PRIORITY
}

const SELECTION_OUTLINE_VISIBLE_COLOR = 0x8b5cf6
const SELECTION_OUTLINE_HIDDEN_COLOR = 0x5b21b6
const SELECTION_OUTLINE_EDGE_STRENGTH = 2.5
const SELECTION_OUTLINE_BLUR = false
const SELECTION_OUTLINE_MULTISAMPLING = 0
const SELECTION_OUTLINE_RESOLUTION_SCALE = 0.5

type RigStats = {
  hasRig: boolean
  skinnedMeshCount: number
  boneCount: number
  jointCount: number
}

type ViewerGeometryStats = {
  vertices: number
  triangles: number
}

export function collectViewer3DSceneStats(scene: THREE.Object3D): ViewerGeometryStats {
  let vertices = 0
  let triangles = 0

  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points)) return

    const positionCount = child.geometry.getAttribute('position')?.count ?? 0
    vertices += positionCount

    if (child instanceof THREE.Mesh) {
      triangles += child.geometry.index
        ? child.geometry.index.count / 3
        : positionCount / 3
    }
  })

  return {
    vertices: Math.round(vertices),
    triangles: Math.round(triangles),
  }
}

function cloneViewer3DMaterial<T extends THREE.Material>(material: T): T {
  return material.clone() as T
}

const viewer3DOwnedMaterials = new WeakMap<THREE.Object3D, Set<THREE.Material>>()
const viewer3DOwnedSkeletons = new WeakMap<THREE.Object3D, Set<THREE.Skeleton>>()
const viewer3DPendingDisposals = new WeakMap<THREE.Object3D, object>()
const viewer3DManagedBoundsTrees = new WeakMap<THREE.BufferGeometry, { tree: unknown; owners: number }>()

export function cloneViewer3DLoadedScene<T extends THREE.Object3D>(source: T): T {
  const clone = cloneSkeleton(source) as T
  // Match the existing pristine-export owner: UUID tracks bind inside this root.
  const preserveBindingIds = (original: THREE.Object3D, instance: THREE.Object3D): void => {
    instance.uuid = original.uuid
    original.children.forEach((child, index) => preserveBindingIds(child, instance.children[index]))
  }
  preserveBindingIds(source, clone)
  const ownedMaterials = new Set<THREE.Material>()
  const ownedSkeletons = new Set<THREE.Skeleton>()
  clone.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) ownedSkeletons.add(child.skeleton)
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points)) return
    child.material = Array.isArray(child.material)
      ? child.material.map((material) => cloneViewer3DMaterial(material))
      : cloneViewer3DMaterial(child.material)
    ;(Array.isArray(child.material) ? child.material : [child.material]).forEach(material => ownedMaterials.add(material))
  })
  viewer3DOwnedMaterials.set(clone, ownedMaterials)
  viewer3DOwnedSkeletons.set(clone, ownedSkeletons)
  return clone
}

export function disposeViewer3DOwnedSceneResources(scene: THREE.Object3D): void {
  const ownedMaterials = viewer3DOwnedMaterials.get(scene)
  viewer3DOwnedMaterials.delete(scene)
  ownedMaterials?.forEach(material => material.dispose())
  const ownedSkeletons = viewer3DOwnedSkeletons.get(scene)
  viewer3DOwnedSkeletons.delete(scene)
  ownedSkeletons?.forEach(skeleton => skeleton.dispose())
}

export function retainViewer3DOwnedSceneResources(scene: THREE.Object3D): () => void {
  viewer3DPendingDisposals.delete(scene)
  let released = false
  return () => {
    if (released) return
    released = true
    const operation = {}
    viewer3DPendingDisposals.set(scene, operation)
    queueMicrotask(() => {
      if (viewer3DPendingDisposals.get(scene) !== operation) return
      viewer3DPendingDisposals.delete(scene)
      disposeViewer3DOwnedSceneResources(scene)
    })
  }
}

export function acquireViewer3DManagedBoundsTree(geometry: THREE.BufferGeometry): boolean {
  const target = geometry as THREE.BufferGeometry & { boundsTree?: unknown }
  const owner = viewer3DManagedBoundsTrees.get(geometry)
  if (owner && target.boundsTree === owner.tree) {
    owner.owners += 1
    return true
  }
  if (target.boundsTree) return false
  // Indirect construction keeps authored triangle-index order intact.
  try {
    ;(geometry as any).computeBoundsTree?.({ indirect: true })
  } catch (error) {
    console.warn('[Viewer3D] BVH acceleration unavailable for geometry:', error)
    return false
  }
  if (!target.boundsTree) return false
  viewer3DManagedBoundsTrees.set(geometry, { tree: target.boundsTree, owners: 1 })
  return true
}

export function releaseViewer3DManagedBoundsTree(geometry: THREE.BufferGeometry): boolean {
  const owner = viewer3DManagedBoundsTrees.get(geometry)
  if (!owner) return false
  if (--owner.owners > 0) return false
  viewer3DManagedBoundsTrees.delete(geometry)
  if ((geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree !== owner.tree) return false
  ;(geometry as any).disposeBoundsTree?.()
  return true
}

export function hasViewer3DRenderableContent(object: THREE.Object3D | null | undefined): boolean {
  let found = false
  object?.traverse((child) => {
    if (found) return
    if (child instanceof THREE.Mesh || child instanceof THREE.Points) found = true
  })
  return found
}

export function shouldEnableViewer3DBvh(args: { editMode: boolean; landmarkPicking?: MeshModelProps['landmarkPicking'] }): boolean {
  return args.editMode || Boolean(args.landmarkPicking)
}

type Viewer3DCameraFrame = {
  target: THREE.Vector3
  position: THREE.Vector3
  near: number
  far: number
  minDistance: number
  maxDistance: number
}

export function resolveViewer3DCameraFrame(args: {
  bounds: THREE.Box3
  aspect: number
  fovDegrees: number
  direction?: THREE.Vector3
  margin?: number
}): Viewer3DCameraFrame | undefined {
  if (args.bounds.isEmpty()) return undefined

  const sphere = args.bounds.getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(sphere.radius, 0.05)
  const aspect = Number.isFinite(args.aspect) && args.aspect > 0 ? args.aspect : 1
  const halfVerticalFov = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(args.fovDegrees, 10, 120) / 2)
  const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * aspect)
  const limitingHalfFov = Math.max(0.01, Math.min(halfVerticalFov, halfHorizontalFov))
  const margin = args.margin ?? 1.2
  const distance = (radius / Math.sin(limitingHalfFov)) * margin
  const direction = args.direction && args.direction.lengthSq() > 1e-6
    ? args.direction.clone().normalize()
    : new THREE.Vector3(0.9, 0.55, 1).normalize()

  const target = sphere.center.clone()
  const position = target.clone().add(direction.multiplyScalar(distance))
  const near = Math.max(0.01, distance - radius * 2.5)
  const far = Math.max(near + 1, distance + radius * 4)

  return {
    target,
    position,
    near,
    far,
    minDistance: Math.max(0.01, radius * 0.15),
    maxDistance: Math.max(distance * 8, radius * 4),
  }
}

export function shouldRenderViewer3DViewportGizmos(args: {
  modelUrl: string | null
  hasCurrentJob: boolean
  object: THREE.Object3D | null | undefined
}): boolean {
  return Boolean(args.modelUrl && args.hasCurrentJob && hasViewer3DRenderableContent(args.object))
}

type JointMarker = {
  bone: THREE.Bone
  boneId?: RigBoneId
  marker: THREE.Mesh
}

type BoneSegment = {
  parent: THREE.Bone
  child: THREE.Bone
  childBoneId?: RigBoneId
}

type RigLineOverlay = {
  line: THREE.LineSegments
  segments: BoneSegment[]
}

type MeshModelClickEvent = ThreeEvent<MouseEvent> & {
  object: THREE.Object3D
  point: THREE.Vector3
  intersections: Array<{ object: THREE.Object3D; point: THREE.Vector3 }>
}

type MotionPlaybackBackend = 'local-retarget-preview' | 'animated-glb'

type Viewer3DAnimationControls = {
  actions: readonly AnimationActionLike[]
  mixer?: AnimationMixerLike | null
}

const RIG_VIEW_MODES: ViewMode[] = ['bones', 'joints', 'influence']

type RigHelperTone = 'default' | 'selected'

type RigHelperMarkerStyle = {
  tone: RigHelperTone
  color: string
  emissive: string
  emissiveIntensity: number
  scale: number
  renderOrder: number
}

type RigHelperSegmentStyle = {
  tone: RigHelperTone
  color: string
  opacity: number
  renderOrder: number
}

type RigHelperStyles = {
  markerStylesByBoneId: Record<RigBoneId, RigHelperMarkerStyle>
  segmentStylesByChildBoneId: Record<RigBoneId, RigHelperSegmentStyle>
  requiresNewMarker: false
}

const DEFAULT_RIG_HELPER_MARKER_STYLE: RigHelperMarkerStyle = {
  tone: 'default',
  color: '#f5f3ff',
  emissive: '#7c3aed',
  emissiveIntensity: 0.55,
  scale: 1,
  renderOrder: 5,
}

const SELECTED_RIG_HELPER_MARKER_STYLE: RigHelperMarkerStyle = {
  tone: 'selected',
  color: '#22d3ee',
  emissive: '#67e8f9',
  emissiveIntensity: 1.35,
  scale: 1.45,
  renderOrder: 7,
}

const DEFAULT_RIG_HELPER_SEGMENT_STYLE: RigHelperSegmentStyle = {
  tone: 'default',
  color: '#38bdf8',
  opacity: 0.98,
  renderOrder: 4,
}

const SELECTED_RIG_HELPER_SEGMENT_STYLE: RigHelperSegmentStyle = {
  tone: 'selected',
  color: '#22d3ee',
  opacity: 1,
  renderOrder: 6,
}

function isRigViewMode(viewMode: ViewMode): boolean {
  return RIG_VIEW_MODES.includes(viewMode)
}

export function resolveViewer3DRigHelperStyles(
  summary: RigSkeletonSummary | undefined,
  selectedBoneId: RigBoneId | undefined,
): RigHelperStyles {
  const selectedExists = Boolean(selectedBoneId && summary?.bones.some((bone) => bone.boneId === selectedBoneId))
  const markerStylesByBoneId: Record<RigBoneId, RigHelperMarkerStyle> = {}
  const segmentStylesByChildBoneId: Record<RigBoneId, RigHelperSegmentStyle> = {}

  for (const bone of summary?.bones ?? []) {
    markerStylesByBoneId[bone.boneId] = selectedExists && bone.boneId === selectedBoneId
      ? SELECTED_RIG_HELPER_MARKER_STYLE
      : DEFAULT_RIG_HELPER_MARKER_STYLE
    if (bone.parentId) {
      segmentStylesByChildBoneId[bone.boneId] = selectedExists && bone.boneId === selectedBoneId
        ? SELECTED_RIG_HELPER_SEGMENT_STYLE
        : DEFAULT_RIG_HELPER_SEGMENT_STYLE
    }
  }

  return { markerStylesByBoneId, segmentStylesByChildBoneId, requiresNewMarker: false }
}

function collectRigBindingFromScene(scene: THREE.Object3D, sourceWorkspacePath?: string) {
  const skinnedMeshes: RigSkinnedMeshContext<THREE.Bone>[] = []
  scene.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh) || !child.skeleton) return
    skinnedMeshes.push({ name: child.name, path: resolveObjectPath(scene, child), skeletonIndex: skinnedMeshes.length, skeleton: child.skeleton })
  })
  return collectRigSkeletonBinding({ sourceWorkspacePath, skinnedMeshes })
}

function resolveObjectPath(root: THREE.Object3D, target: THREE.Object3D): string[] {
  const path: string[] = []
  let cursor: THREE.Object3D | null = target

  while (cursor && cursor !== root) {
    path.unshift(cursor.name || cursor.type)
    cursor = cursor.parent
  }

  return path.length > 0 ? path : [target.name || target.type]
}

function buildInfluencePalette(size: number): THREE.Color[] {
  return Array.from({ length: Math.max(size, 1) }, (_, index) => {
    const color = new THREE.Color()
    color.setHSL((index * 0.61803398875) % 1, 0.72, 0.58)
    return color
  })
}

function ensureInfluenceColors(geometry: THREE.BufferGeometry, palette: THREE.Color[]): void {
  const position = geometry.getAttribute('position')
  const skinIndex = geometry.getAttribute('skinIndex')
  const skinWeight = geometry.getAttribute('skinWeight')

  if (!position || !skinIndex || !skinWeight) return

  const vertexCount = position.count
  const colors = new Float32Array(vertexCount * 3)
  const neutral = new THREE.Color('#27272a')

  for (let index = 0; index < vertexCount; index += 1) {
    let bestWeight = -1
    let bestBoneIndex = 0

    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.getComponent(index, slot)
      if (weight > bestWeight) {
        bestWeight = weight
        bestBoneIndex = skinIndex.getComponent(index, slot)
      }
    }

    const color = neutral.clone().lerp(palette[bestBoneIndex % palette.length] ?? new THREE.Color('#a855f7'), Math.max(0.2, bestWeight))
    colors[index * 3] = color.r
    colors[index * 3 + 1] = color.g
    colors[index * 3 + 2] = color.b
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

function createInfluenceMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.72,
    metalness: 0.08,
    vertexColors: true,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  material.toneMapped = true
  return material
}

function createRigShellMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: '#f8fafc',
    roughness: 0.82,
    metalness: 0.02,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

function createMutedRigBackdropMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: '#18181b',
    roughness: 0.9,
    metalness: 0.0,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

const EMPTY_RIG_STATS: RigStats = { hasRig: false, skinnedMeshCount: 0, boneCount: 0, jointCount: 0 }

// Auxiliary objects never enter the source hierarchy, BVH, stats or Select.
// One owned line buffer connects only bones referenced by the source skeletons.
function RigInspectionOverlay({ scene, viewMode, binding, selectedBoneId }: { scene: THREE.Object3D; viewMode: ViewMode; binding: LoadedScene['binding']; selectedBoneId?: RigBoneId }): JSX.Element {
  const overlay = useMemo(() => {
    const group = new THREE.Group()
    group.name = 'RigInspectionOverlay'
    group.matrixAutoUpdate = false
    return group
  }, [scene])
  const rigLineOverlay = useRef<RigLineOverlay | null>(null)
  const jointMarkers = useRef<JointMarker[]>([])
  const sceneInverse = useMemo(() => new THREE.Matrix4(), [])
  const localPosition = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    const bones = new Set(binding.bonesById.values())
    const segments: BoneSegment[] = []
    bones.forEach((bone) => {
      if (bone.parent instanceof THREE.Bone && bones.has(bone.parent)) {
        segments.push({ parent: bone.parent, child: bone })
      }
    })
    if (segments.length > 0) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments.length * 6), 3))
      const material = new THREE.LineBasicMaterial({
        color: viewMode === 'influence' ? '#f8fafc' : '#38bdf8',
        transparent: true,
        opacity: viewMode === 'influence' ? 0.72 : 0.98,
        depthTest: false,
        depthWrite: false,
      })
      const line = new THREE.LineSegments(geometry, material)
      line.frustumCulled = false
      line.renderOrder = 4
      line.raycast = () => undefined
      overlay.add(line)
      rigLineOverlay.current = { line, segments }
    }
    if (viewMode === 'joints' || viewMode === 'influence') {
      bones.forEach((bone) => {
        const marker = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.026, 0),
          new THREE.MeshStandardMaterial({ color: '#f5f3ff', emissive: '#7c3aed', emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.08, depthTest: false, depthWrite: false }),
        )
        marker.frustumCulled = false
        marker.renderOrder = 5
        marker.raycast = () => undefined
        overlay.add(marker)
        jointMarkers.current.push({ bone, marker })
      })
    }
    return () => {
      if (rigLineOverlay.current) {
        rigLineOverlay.current.line.geometry.dispose()
        ;(rigLineOverlay.current.line.material as THREE.Material).dispose()
        rigLineOverlay.current = null
      }
      jointMarkers.current.forEach(({ marker }) => {
        marker.geometry.dispose()
        ;(marker.material as THREE.Material).dispose()
      })
      jointMarkers.current = []
      overlay.clear()
    }
  }, [scene, viewMode, overlay, binding])

  useEffect(() => {
    const selected = selectedBoneId ? binding.bonesById.get(selectedBoneId) : undefined
    for (const { bone, marker } of jointMarkers.current) {
      const style = bone === selected ? SELECTED_RIG_HELPER_MARKER_STYLE : DEFAULT_RIG_HELPER_MARKER_STYLE
      const material = marker.material as THREE.MeshStandardMaterial
      material.color.set(style.color); material.emissive.set(style.emissive)
      material.emissiveIntensity = style.emissiveIntensity
      marker.scale.setScalar(style.scale); marker.renderOrder = style.renderOrder
    }
    const line = rigLineOverlay.current
    if (line) {
      const colors = new Float32Array(line.segments.length * 6)
      line.segments.forEach(({ child }, index) => {
        const color = new THREE.Color(child === selected ? '#22d3ee' : viewMode === 'influence' ? '#f8fafc' : '#38bdf8')
        color.toArray(colors, index * 6); color.toArray(colors, index * 6 + 3)
      })
      line.line.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const material = line.line.material as THREE.LineBasicMaterial
      material.color.set('#ffffff'); material.vertexColors = true; material.needsUpdate = true
    }
  }, [binding, selectedBoneId, viewMode])

  // Mixer updates run at -1, before this normal-priority inspection update.
  useFrame(() => {
    scene.updateWorldMatrix(true, true)
    overlay.matrix.copy(scene.matrix)
    sceneInverse.copy(scene.matrixWorld).invert()
    const lineOverlay = rigLineOverlay.current
    if (lineOverlay) {
      const position = lineOverlay.line.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let index = 0; index < lineOverlay.segments.length; index += 1) {
        const { parent, child } = lineOverlay.segments[index]
        // getWorldPosition updates ancestors, including detached skeleton roots.
        parent.getWorldPosition(localPosition).applyMatrix4(sceneInverse)
        position.setXYZ(index * 2, localPosition.x, localPosition.y, localPosition.z)
        child.getWorldPosition(localPosition).applyMatrix4(sceneInverse)
        position.setXYZ(index * 2 + 1, localPosition.x, localPosition.y, localPosition.z)
      }
      position.needsUpdate = true
    }
    for (const { bone, marker } of jointMarkers.current) {
      bone.getWorldPosition(marker.position).applyMatrix4(sceneInverse)
    }
    overlay.updateMatrixWorld(true)
  })

  return <primitive object={overlay} />
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function createMatcapTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size * 0.35, size * 0.3, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.45, '#aaaaaa')
  grad.addColorStop(1, '#222222')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

function createCheckerTexture(): THREE.CanvasTexture {
  const size = 256
  const tileCount = 8
  const tileSize = size / tileCount
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  for (let row = 0; row < tileCount; row++) {
    for (let col = 0; col < tileCount; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#e0e0e0' : '#888888'
      ctx.fillRect(col * tileSize, row * tileSize, tileSize, tileSize)
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

const SELECTION_OUTLINE_COLOR = '#8b5cf6'

function makeLightBulbTexture(color: string, isSelected: boolean): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  const cx = size / 2
  const cy = size / 2

  // Draws the bulb glyph (rays + circle + base). `pad` grows every part by a
  // few pixels — used to lay down an oversized violet silhouette behind the
  // normal-sized icon, so the outline hugs the actual glyph shape instead of
  // being a plain circle around it.
  const drawGlyph = (fillColor: string, pad: number) => {
    ctx.strokeStyle = fillColor
    ctx.lineWidth = 2 + pad * 2
    ctx.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2
      const r1 = 20 - pad
      const r2 = 27 + pad
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.arc(cx, cy - 1, 12 + pad, 0, Math.PI * 2)
    ctx.fillStyle = fillColor
    ctx.fill()
    if (pad === 0) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    ctx.fillStyle = fillColor
    ctx.fillRect(cx - 4 - pad, cy + 11 - pad, 8 + pad * 2, 8 + pad * 2)
    if (pad === 0) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.strokeRect(cx - 4, cy + 11, 8, 8)
    }
  }

  if (isSelected) drawGlyph(SELECTION_OUTLINE_COLOR, 2.5)
  drawGlyph(color, 0)

  return new THREE.CanvasTexture(canvas)
}

// ---------------------------------------------------------------------------
// CanvasCapture — exposes gl.domElement ref outside Canvas
// ---------------------------------------------------------------------------

function CanvasCapture({
  domRef,
}: {
  domRef: React.MutableRefObject<HTMLCanvasElement | null>
}): null {
  const { gl } = useThree()
  useEffect(() => {
    domRef.current = gl.domElement
  }, [gl])
  return null
}

// ---------------------------------------------------------------------------
// ModelErrorBoundary — catches useGLTF load failures (e.g. 404)
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string | null
}

interface ErrorBoundaryState {
  hasError: boolean
}

class ModelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('[Viewer3D] Failed to load model:', error.message, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

function ModelLoadError(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600 pointer-events-none">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <p className="mt-3 text-sm">Model file not found</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MeshModel
// ---------------------------------------------------------------------------

type LoadedScene = {
  url: string
  scene: THREE.Object3D
  parts: ScenePart[]
  animations: readonly THREE.AnimationClip[]
  binding: ReturnType<typeof collectRigBindingFromScene>
  originalMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>
  originalGeometries: Map<THREE.Mesh, THREE.BufferGeometry>
}

interface MeshModelProps {
  url: string
  rigSourceWorkspacePath?: string
  viewMode: ViewMode
  selected: boolean
  animationPlaying: boolean
  poseOwnerRef: MutableRefObject<THREE.Object3D | null>
  onStats: (stats: ViewerGeometryStats) => void
  onSelect: (partId: string | null) => void
  onAnimationControlsReady?: (scene: THREE.Object3D, controls: Viewer3DAnimationControls | null) => void
  onObject: (object: THREE.Object3D | null) => void
  onAnimationAvailability: (available: boolean) => void
  onRigStats: (stats: RigStats) => void
  onSceneReady: (source: LoadedScene | null) => void
  selectedBoneId?: RigBoneId
  editMode: boolean
  landmarkPicking?: { activeLandmarkId: LandmarkId; onPoint: (point: LandmarkPoint) => void }
}

function MeshModel(props: MeshModelProps): JSX.Element {
  const extension = props.url.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase()
  return extension === 'obj' ? <ObjMeshModel {...props} /> : <GltfMeshModel {...props} />
}

function GltfMeshModel(props: MeshModelProps): JSX.Element {
  const { scene: loadedScene, animations } = useGLTF(props.url)
  const scene = useMemo(() => cloneViewer3DLoadedScene(loadedScene), [loadedScene])
  const { animationPlaying, onAnimationAvailability, poseOwnerRef, onAnimationControlsReady } = props
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const actionsRef = useRef<THREE.AnimationAction[]>([])

  useEffect(() => {
    onAnimationAvailability(resolveAnimationAvailability(animations))
    return () => onAnimationAvailability(false)
  }, [scene, animations, onAnimationAvailability])

  useEffect(() => {
    if (!resolveAnimationAvailability(animations)) return
    const mixer = new THREE.AnimationMixer(scene)
    const actions = animations.map((clip) => mixer.clipAction(clip))
    mixerRef.current = mixer
    actionsRef.current = actions
    onAnimationControlsReady?.(scene, { actions, mixer })

    return () => {
      resetAnimationPlayback({ actions, mixer })
      mixer.stopAllAction()
      mixer.uncacheRoot(scene)
      actionsRef.current = []
      mixerRef.current = null
      onAnimationControlsReady?.(scene, null)
    }
  }, [scene, animations, onAnimationControlsReady])

  useEffect(() => {
    syncAnimationActions(actionsRef.current, animationPlaying && resolveAnimationAvailability(animations))
  }, [animationPlaying, scene, animations])

  useFrame((_, delta) => {
    if (animationPlaying && poseOwnerRef.current !== scene && mixerRef.current) {
      mixerRef.current.update(delta)
    }
  }, -1)

  return <SceneMeshModel {...props} scene={scene} animations={animations} />
}

const EMPTY_ANIMATIONS: readonly THREE.AnimationClip[] = []

function ObjMeshModel(props: MeshModelProps): JSX.Element {
  const loadedScene = useLoader(OBJLoader, props.url)
  const scene = useMemo(() => cloneViewer3DLoadedScene(loadedScene), [loadedScene])
  const { onAnimationAvailability } = props
  useEffect(() => { onAnimationAvailability(false) }, [onAnimationAvailability])
  return <SceneMeshModel {...props} scene={scene} animations={EMPTY_ANIMATIONS} />
}

function SceneMeshModel({
  url,
  viewMode,
  selected,
  onStats,
  onSelect,
  onObject,
  onRigStats,
  scene,
  animations,
  rigSourceWorkspacePath,
  selectedBoneId,
  onSceneReady,
  editMode,
  landmarkPicking,
}: MeshModelProps & {
  scene: THREE.Group | THREE.Scene
  animations: readonly THREE.AnimationClip[]
}): JSX.Element {
  const captured = useRef(false)
  const { gl } = useThree()
  const originals = useMemo(() => {
    const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    const originalGeometries = new Map<THREE.Mesh, THREE.BufferGeometry>()
    scene.traverse(child => {
      if (child instanceof THREE.Mesh) {
        originalMaterials.set(child, child.material)
        originalGeometries.set(child, child.geometry)
      }
    })
    return { originalMaterials, originalGeometries }
  }, [scene])
  const source = useMemo<LoadedScene>(() => ({ url, scene, animations,
    binding: collectRigBindingFromScene(scene, rigSourceWorkspacePath),
    parts: collectSceneParts(scene, { animationClips: animations }), ...originals,
  }), [scene, animations, url, rigSourceWorkspacePath, originals])
  const rigStats = useMemo<RigStats>(() => ({ hasRig: source.binding.summary.hasRig,
    ...source.binding.summary.stats, jointCount: source.binding.summary.stats.boneCount }), [source])
  useEffect(() => {
    onSceneReady(source)
    return () => onSceneReady(null)
  }, [source, onSceneReady])
  const effectiveViewMode = isRigViewMode(viewMode) && !rigStats.hasRig ? 'solid' : viewMode

  useEffect(() => {
    onRigStats(rigStats)
    return () => onRigStats(EMPTY_RIG_STATS)
  }, [rigStats, onRigStats])

  // Expose the scene object so Viewer3D can attach the transform gizmo to it.
  useEffect(() => {
    onObject(hasViewer3DRenderableContent(scene) ? scene : null)
    return () => onObject(null)
  }, [scene, onObject])

  // Dispose only the per-instance cloned materials we own. Loader caches and
  // shared geometries stay intact so StrictMode remounts do not invalidate them.
  useEffect(() => {
    return retainViewer3DOwnedSceneResources(scene)
  }, [scene])

  useEffect(() => {
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach((material) => {
        material.side = THREE.DoubleSide
        material.needsUpdate = true
      })
    })
  }, [scene])

  // Build BVHs only when edit/picking features need accelerated raycasts.
  useEffect(() => {
    if (!shouldEnableViewer3DBvh({ editMode, landmarkPicking })) return

    let cancelled = false
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null
    let idleId: number | null = null
    const built = new Set<THREE.BufferGeometry>()
    const geometries = new Set<THREE.BufferGeometry>()
    originals.originalGeometries.forEach((geometry, mesh) => {
      if (!(mesh instanceof THREE.SkinnedMesh)) geometries.add(geometry)
    })

    const build = () => {
      if (cancelled) return
      geometries.forEach(geometry => {
        if (acquireViewer3DManagedBoundsTree(geometry)) built.add(geometry)
      })
    }

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => build())
    } else {
      timeoutId = globalThis.setTimeout(build, 0)
    }

    return () => {
      cancelled = true
      if (idleId !== null && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId)
      built.forEach(releaseViewer3DManagedBoundsTree)
      built.clear()
    }
  }, [editMode, landmarkPicking, scene, originals])

  // Preserve authored transforms. Only collect stats when the loaded scene changes.
  useEffect(() => {
    onStats(collectViewer3DSceneStats(scene))
  }, [scene, onStats])

  // Thumbnail capture (kept for future use)
  useEffect(() => {
    captured.current = false
  }, [url])

  // Each mode owns only its temporary material, textures and influence geometry.
  // Restoring object references also preserves material arrays and vertex colors.
  useEffect(() => {
    const restore: (() => void)[] = []
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const originalMaterial = child.material
      const originalGeometry: THREE.BufferGeometry = child.geometry
      let next: THREE.Material | THREE.Material[] = originalMaterial
      let geometry: THREE.BufferGeometry | undefined
      let texture: THREE.Texture | undefined
      switch (effectiveViewMode) {
        case 'bones':
        case 'joints':
          next = createRigShellMaterial()
          break
        case 'influence':
          if (child instanceof THREE.SkinnedMesh && child.skeleton) {
            geometry = originalGeometry.clone()
            ensureInfluenceColors(geometry, buildInfluencePalette(child.skeleton.bones.length))
            child.geometry = geometry
            next = createInfluenceMaterial()
          } else {
            next = createMutedRigBackdropMaterial()
          }
          break
        case 'wireframe':
          next = new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true })
          break
        case 'normals':
          child.geometry.computeVertexNormals()
          next = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide })
          break
        case 'matcap':
          texture = createMatcapTexture()
          next = new THREE.MeshMatcapMaterial({ matcap: texture })
          break
        case 'uv':
          texture = createCheckerTexture()
          next = new THREE.MeshBasicMaterial({ map: texture })
          break
      }
      child.material = next
      restore.push(() => {
        child.material = originalMaterial
        child.geometry = originalGeometry
        if (next !== originalMaterial) (next as THREE.Material).dispose()
        texture?.dispose()
        geometry?.dispose()
      })
    })
    return () => restore.forEach((cleanup) => cleanup())
  }, [scene, effectiveViewMode])

  return (
    <>
      <Select enabled={selected}>
        <primitive
          object={scene}
          onClick={(event: MeshModelClickEvent) => {
            if (landmarkPicking) {
              const pointer = event.nativeEvent
              const intent = createLandmarkPointIntent({ activeLandmarkId: landmarkPicking.activeLandmarkId,
                pointer: { clientX: pointer?.clientX, clientY: pointer?.clientY }, canvas: gl.domElement,
                intersections: event.intersections ?? [], clickableObjects: [scene] })
              if (intent) { event.stopPropagation(); landmarkPicking.onPoint(intent.point) }
              return
            }
            if (event.object && scene.getObjectById(event.object.id) !== event.object) return
            const partId = editMode ? resolveScenePartIdForObject({ scene, target: event.object, parts: source.parts }) : null
            event.stopPropagation()
            onSelect(partId)
          }}
        />
      </Select>
      {rigStats.hasRig && isRigViewMode(effectiveViewMode) && (
        <RigInspectionOverlay scene={scene} viewMode={effectiveViewMode} binding={source.binding} selectedBoneId={selectedBoneId} />
      )}
    </>
  )

}

function SceneFrameController({ object, frameKey, controlsRef }: {
  object: THREE.Object3D | null
  frameKey: string | null
  controlsRef: MutableRefObject<OrbitControlsImpl | null>
}): null {
  const { camera, size, invalidate } = useThree()
  const lastFramedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!object || !frameKey || lastFramedKeyRef.current === frameKey || !hasViewer3DRenderableContent(object)) return

    object.updateMatrixWorld(true)
    const frame = resolveViewer3DCameraFrame({
      bounds: new THREE.Box3().setFromObject(object),
      aspect: size.width > 0 && size.height > 0 ? size.width / size.height : 1,
      fovDegrees: camera instanceof THREE.PerspectiveCamera ? camera.fov : 45,
      direction: camera.position.clone().sub(controlsRef.current?.target ?? new THREE.Vector3()),
    })
    if (!frame) return

    camera.position.copy(frame.position)
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = frame.near
      camera.far = frame.far
      camera.updateProjectionMatrix()
    }

    if (controlsRef.current) {
      controlsRef.current.target.copy(frame.target)
      controlsRef.current.minDistance = frame.minDistance
      controlsRef.current.maxDistance = frame.maxDistance
      controlsRef.current.update()
    }

    lastFramedKeyRef.current = frameKey
    invalidate()
  }, [camera, controlsRef, frameKey, invalidate, object, size.height, size.width])

  return null
}

function LandmarkMarkers({
  markers,
  onSelectLandmark,
}: {
  markers: readonly LandmarkMarkerViewModel[]
  onSelectLandmark?: (id: LandmarkId) => void
}): JSX.Element | null {
  const [hoveredMarkerId, setHoveredMarkerId] = useState<LandmarkId | null>(null)
  const renderModels = resolveLandmarkMarkerRenderModels(markers, hoveredMarkerId)
  if (markers.length === 0) return null

  return (
    <group>
      {renderModels.map((marker) => {
        return (
          <group key={marker.id} position={[marker.position.x, marker.position.y, marker.position.z]}>
            <mesh
              renderOrder={6}
              onClick={(event) => { event.stopPropagation(); onSelectLandmark?.(marker.id) }}
              onPointerOver={(event) => { event.stopPropagation(); setHoveredMarkerId(marker.id) }}
              onPointerOut={() => setHoveredMarkerId((current) => current === marker.id ? null : current)}
            >
              <sphereGeometry args={[0.035, 12, 12]} />
              <meshBasicMaterial color={marker.color} depthTest={false} toneMapped={false} />
            </mesh>
            <Html position={[0, 0.055, 0]} center distanceFactor={5} zIndexRange={[10, 0]}>
              <span className="pointer-events-none inline-flex min-w-4 items-center justify-center rounded-full bg-zinc-950/85 border border-white/20 px-1 py-0.5 text-[8px] font-bold leading-none text-white shadow">
                {marker.badgeLabel}
              </span>
            </Html>
            {marker.showFullLabel && (
              <Html position={[0, 0.105, 0]} center distanceFactor={5} zIndexRange={[11, 0]}>
                <span className="pointer-events-none whitespace-nowrap rounded bg-zinc-950/90 border border-amber-400/40 px-1 py-0.5 text-[9px] font-medium leading-none text-amber-100 shadow">
                  {marker.fullLabel}
                </span>
              </Html>
            )}
          </group>
        )
      })}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Orientation gizmo — coloured bubbles only (X/Y/Z)
// ---------------------------------------------------------------------------

function makeAxisLabelTexture(letter: string, bg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(32, 32, 16, 0, 2 * Math.PI)
  ctx.closePath()
  ctx.fillStyle = bg
  ctx.fill()
  ctx.font = '18px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(letter, 32, 41)
  return new THREE.CanvasTexture(canvas)
}

const GIZMO_AXES: {
  letter: string
  color: string
  pos: [number, number, number]
  lineRotation: [number, number, number]
}[] = [
  { letter: 'X', color: '#f87171', pos: [1, 0, 0], lineRotation: [0, 0, 0] },
  { letter: 'Y', color: '#4ade80', pos: [0, 1, 0], lineRotation: [0, 0, Math.PI / 2] },
  { letter: 'Z', color: '#60a5fa', pos: [0, 0, 1], lineRotation: [0, -Math.PI / 2, 0] },
]

function AxisLine({ color, rotation }: { color: string; rotation: [number, number, number] }) {
  return (
    <group rotation={rotation}>
      <mesh position={[0.4, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  )
}

function AxisBubble({ letter, color, pos }: { letter: string; color: string; pos: [number, number, number] }) {
  const { tweenCamera } = useGizmoContext()
  const texture = useMemo(() => makeAxisLabelTexture(letter, color), [letter, color])
  const [hovered, setHovered] = useState(false)

  return (
    <sprite
      position={pos}
      scale={hovered ? 1.2 : 1}
      onPointerDown={(e) => { tweenCamera(e.object.position); e.stopPropagation() }}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <spriteMaterial map={texture} alphaTest={0.3} toneMapped={false} />
    </sprite>
  )
}

function GizmoBubbles() {
  return (
    <group scale={40}>
      {GIZMO_AXES.map((axis) => (
        <AxisLine key={`line-${axis.letter}`} color={axis.color} rotation={axis.lineRotation} />
      ))}
      {GIZMO_AXES.map((axis) => (
        <AxisBubble key={axis.letter} {...axis} />
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Transform gizmos — custom move / rotate / scale handles (shared style)
// ---------------------------------------------------------------------------

type GizmoAxis = 'x' | 'y' | 'z'
type TranslateHandleId = GizmoAxis | 'xy' | 'yz' | 'xz'
type ScaleHandleId = GizmoAxis | 'xyz'

const AXIS_COLORS: Record<GizmoAxis, string> = {
  x: '#f87171',
  y: '#4ade80',
  z: '#60a5fa',
}

const AXIS_DIR: Record<GizmoAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

// Orient a +Y cylinder/cone/box onto each axis.
const AXIS_ROTATION: Record<GizmoAxis, [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
}

// Orient a default-XY torus so its ring spins around each axis.
const RING_ROTATION: Record<GizmoAxis, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
}

// Two-axis plane handles, coloured by their locked (normal) axis.
const PLANE_HANDLES: {
  id: 'xy' | 'yz' | 'xz'
  normal: [number, number, number]
  color: string
  position: [number, number, number]
  rotation: [number, number, number]
}[] = [
  { id: 'xy', normal: [0, 0, 1], color: AXIS_COLORS.z, position: [0.26, 0.26, 0], rotation: [0, 0, 0] },
  { id: 'yz', normal: [1, 0, 0], color: AXIS_COLORS.x, position: [0, 0.26, 0.26], rotation: [0, -Math.PI / 2, 0] },
  { id: 'xz', normal: [0, 1, 0], color: AXIS_COLORS.y, position: [0.26, 0, 0.26], rotation: [Math.PI / 2, 0, 0] },
]

const GIZMO_SCREEN_SIZE = 0.12

function lightenColor(hex: string, amount = 0.5): string {
  return '#' + new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), amount).getHexString()
}

function intersectPlane(ray: THREE.Ray, origin: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin)
  const hit = new THREE.Vector3()
  return ray.intersectPlane(plane, hit) ? hit : null
}

// Shared plumbing: follow the object, keep a constant on-screen size, and run
// the pointer-drag lifecycle (window listeners + OrbitControls locking).
function useGizmoBase(object: THREE.Object3D) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const raycaster = useThree((s) => s.raycaster)
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null

  const groupRef = useRef<THREE.Group>(null)
  const ndc = useRef(new THREE.Vector2())
  const moveRef = useRef<((ev: PointerEvent) => void) | null>(null)
  const endRef = useRef<(() => void) | null>(null)

  useFrame(() => {
    const g = groupRef.current
    if (!g) return
    object.getWorldPosition(g.position)
    g.scale.setScalar(Math.max(camera.position.distanceTo(g.position) * GIZMO_SCREEN_SIZE, 0.001))
  })

  const pointerRay = useCallback((ev: PointerEvent): THREE.Ray => {
    const rect = gl.domElement.getBoundingClientRect()
    ndc.current.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc.current, camera)
    return raycaster.ray
  }, [camera, gl, raycaster])

  const stop = useCallback(() => {
    if (!moveRef.current) return
    window.removeEventListener('pointermove', moveRef.current)
    window.removeEventListener('pointerup', stop)
    moveRef.current = null
    endRef.current?.()
    endRef.current = null
    if (controls) controls.enabled = true
    gl.domElement.style.cursor = ''
  }, [controls, gl])

  const start = useCallback((onMove: (ev: PointerEvent) => void, onEnd?: () => void) => {
    moveRef.current = onMove
    endRef.current = onEnd ?? null
    if (controls) controls.enabled = false
    gl.domElement.style.cursor = 'grabbing'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
  }, [controls, gl, stop])

  useEffect(() => stop, [stop])  // release the drag if unmounted mid-interaction

  return { camera, groupRef, pointerRay, start }
}

function hoverHandlers<T extends string>(
  id: T,
  setHovered: (value: T | null) => void,
  onDown: (e: ThreeEvent<PointerEvent>) => void,
) {
  return {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(id) },
    onPointerOut: () => setHovered(null),
    onPointerDown: onDown,
  }
}

function GizmoArrow({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target spanning the whole arm */}
      <mesh position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 1.1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Shaft */}
      <mesh position={[0, 0.48, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.014, 0.014, 0.66, 16]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
      {/* Arrowhead */}
      <mesh position={[0, 0.9, 0]} renderOrder={999}>
        <coneGeometry args={[0.055, 0.2, 20]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoScaleArm({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target — starts above the centre cube so a
          centre click hits the uniform-scale handle, not an axis */}
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Shaft */}
      <mesh position={[0, 0.42, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.014, 0.014, 0.7, 16]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
      {/* Cube head */}
      <mesh position={[0, 0.84, 0]} renderOrder={999}>
        <boxGeometry args={[0.11, 0.11, 0.11]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoRing({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target */}
      <mesh>
        <torusGeometry args={[0.9, 0.06, 8, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh renderOrder={999}>
        <torusGeometry args={[0.9, 0.012, 12, 64]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoPlane({ color, active }: { color: string; active: boolean }): JSX.Element {
  return (
    <mesh renderOrder={998}>
      <planeGeometry args={[0.26, 0.26]} />
      <meshBasicMaterial
        color={active ? lightenColor(color) : color}
        transparent
        opacity={active ? 0.6 : 0.28}
        side={THREE.DoubleSide}
        toneMapped={false}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  )
}

function TranslateGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { camera, groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<TranslateHandleId | null>(null)
  const [activeId, setActiveId] = useState<TranslateHandleId | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3 | null
    planeNormal: THREE.Vector3
    origin: THREE.Vector3
    startHit: THREE.Vector3
    startPos: THREE.Vector3
  } | null>(null)

  const beginDrag = useCallback((id: TranslateHandleId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    const startPos = object.position.clone()

    let axisDir: THREE.Vector3 | null = null
    let planeNormal: THREE.Vector3
    if (id === 'x' || id === 'y' || id === 'z') {
      axisDir = new THREE.Vector3(...AXIS_DIR[id])
      // Drag plane: contains the axis and faces the camera as much as possible.
      const view = new THREE.Vector3().subVectors(camera.position, origin)
      planeNormal = view.sub(axisDir.clone().multiplyScalar(view.dot(axisDir)))
      if (planeNormal.lengthSq() < 1e-6) planeNormal.set(axisDir.y ? 1 : 0, axisDir.y ? 0 : 1, 0)
      planeNormal.normalize()
    } else {
      planeNormal = new THREE.Vector3(...PLANE_HANDLES.find((p) => p.id === id)!.normal)
    }

    const startHit = intersectPlane(e.ray, origin, planeNormal)
    if (!startHit) return
    drag.current = { axisDir, planeNormal, origin, startHit, startPos }
    setActiveId(id)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.planeNormal)
      if (!hit) return
      const delta = new THREE.Vector3().subVectors(hit, d.startHit)
      if (d.axisDir) {
        object.position.copy(d.startPos).addScaledVector(d.axisDir, delta.dot(d.axisDir))
      } else {
        object.position.copy(d.startPos).add(delta)
      }
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, camera, pointerRay, start, onDragStart, onDragEnd])

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Central origin handle (decorative — never blocks picking) */}
      <mesh raycast={() => null} renderOrder={999}>
        <sphereGeometry args={[0.05, 20, 20]} />
        <meshBasicMaterial color="#e4e4e7" toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>

      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={AXIS_ROTATION[axis]} {...hoverHandlers<TranslateHandleId>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoArrow color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}

      {PLANE_HANDLES.map((plane) => (
        <group key={plane.id} position={plane.position} rotation={plane.rotation} {...hoverHandlers<TranslateHandleId>(plane.id, setHovered, (e) => beginDrag(plane.id, e))}>
          <GizmoPlane color={plane.color} active={hovered === plane.id || activeId === plane.id} />
        </group>
      ))}
    </group>
  )
}

function RotateGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<GizmoAxis | null>(null)
  const [activeId, setActiveId] = useState<GizmoAxis | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3
    origin: THREE.Vector3
    startVec: THREE.Vector3
    startQuat: THREE.Quaternion
  } | null>(null)

  const beginDrag = useCallback((axis: GizmoAxis, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    const axisDir = new THREE.Vector3(...AXIS_DIR[axis]).normalize()
    // Rotation happens in the plane perpendicular to the axis (the ring's plane).
    const startHit = intersectPlane(e.ray, origin, axisDir)
    if (!startHit) return
    const startVec = new THREE.Vector3().subVectors(startHit, origin)
    if (startVec.lengthSq() < 1e-9) return
    drag.current = { axisDir, origin, startVec, startQuat: object.quaternion.clone() }
    setActiveId(axis)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.axisDir)
      if (!hit) return
      const cur = new THREE.Vector3().subVectors(hit, d.origin)
      // Signed angle between the start and current vectors, around the axis.
      const cross = new THREE.Vector3().crossVectors(d.startVec, cur)
      const angle = Math.atan2(cross.dot(d.axisDir), d.startVec.dot(cur))
      const q = new THREE.Quaternion().setFromAxisAngle(d.axisDir, angle)
      object.quaternion.copy(d.startQuat).premultiply(q)
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, pointerRay, start, onDragStart, onDragEnd])

  return (
    <group ref={groupRef} renderOrder={999}>
      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={RING_ROTATION[axis]} {...hoverHandlers<GizmoAxis>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoRing color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}
    </group>
  )
}

function ScaleGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { camera, groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<ScaleHandleId | null>(null)
  const [activeId, setActiveId] = useState<ScaleHandleId | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3 | null
    planeNormal: THREE.Vector3
    origin: THREE.Vector3
    startProj: number
    startScale: THREE.Vector3
    armLength: number
  } | null>(null)

  const beginDrag = useCallback((id: ScaleHandleId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    // World length of one local unit — maps drag distance to a sensible factor.
    const armLength = Math.max(groupRef.current?.scale.x ?? 1, 1e-4)

    let axisDir: THREE.Vector3 | null = null
    let planeNormal: THREE.Vector3
    if (id === 'xyz') {
      planeNormal = new THREE.Vector3().subVectors(camera.position, origin).normalize()
    } else {
      axisDir = new THREE.Vector3(...AXIS_DIR[id])
      const view = new THREE.Vector3().subVectors(camera.position, origin)
      planeNormal = view.sub(axisDir.clone().multiplyScalar(view.dot(axisDir)))
      if (planeNormal.lengthSq() < 1e-6) planeNormal.set(axisDir.y ? 1 : 0, axisDir.y ? 0 : 1, 0)
      planeNormal.normalize()
    }

    const startHit = intersectPlane(e.ray, origin, planeNormal)
    if (!startHit) return
    const startRel = new THREE.Vector3().subVectors(startHit, origin)
    const startProj = axisDir ? startRel.dot(axisDir) : startRel.length()
    drag.current = { axisDir, planeNormal, origin, startProj, startScale: object.scale.clone(), armLength }
    setActiveId(id)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.planeNormal)
      if (!hit) return
      const rel = new THREE.Vector3().subVectors(hit, d.origin)
      const proj = d.axisDir ? rel.dot(d.axisDir) : rel.length()
      const factor = Math.max(0.01, 1 + (proj - d.startProj) / d.armLength)
      if (d.axisDir) {
        const s = d.startScale.clone()
        if (d.axisDir.x) s.x = Math.max(0.01, d.startScale.x * factor)
        if (d.axisDir.y) s.y = Math.max(0.01, d.startScale.y * factor)
        if (d.axisDir.z) s.z = Math.max(0.01, d.startScale.z * factor)
        object.scale.copy(s)
      } else {
        object.scale.copy(d.startScale).multiplyScalar(factor)
      }
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, camera, pointerRay, start, groupRef, onDragStart, onDragEnd])

  const uniformActive = hovered === 'xyz' || activeId === 'xyz'

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Central cube — uniform scale */}
      <mesh {...hoverHandlers<ScaleHandleId>('xyz', setHovered, (e) => beginDrag('xyz', e))} renderOrder={999}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshBasicMaterial color={uniformActive ? lightenColor('#e4e4e7') : '#e4e4e7'} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>

      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={AXIS_ROTATION[axis]} {...hoverHandlers<ScaleHandleId>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoScaleArm color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// PointLightMarker — renders a point light + billboard icon + optional gizmo
// ---------------------------------------------------------------------------

function PointLightMarker({
  light,
  isSelected,
  gizmoMode,
  onSelect,
  onPositionChange,
}: {
  light: PointLight
  isSelected: boolean
  gizmoMode: GizmoMode | null
  onSelect: () => void
  onPositionChange: (pos: [number, number, number]) => void
}) {
  const [group, setGroup] = useState<THREE.Group | null>(null)
  const iconTexture = useMemo(() => makeLightBulbTexture(light.color, isSelected), [light.color, isSelected])

  return (
    <>
      <group ref={setGroup} position={light.position}>
        <pointLight color={light.color} intensity={light.intensity} distance={8} decay={2} />
        <sprite
          scale={[0.3, 0.3, 1]}
          onClick={(e) => { e.stopPropagation(); onSelect() }}
        >
          <spriteMaterial map={iconTexture} toneMapped={false} depthTest={false} />
        </sprite>
      </group>
      {group && isSelected && gizmoMode === 'translate' && (
        <TranslateGizmo
          object={group}
          onDragEnd={() => onPositionChange([group.position.x, group.position.y, group.position.z])}
        />
      )}
      {group && isSelected && gizmoMode === 'rotate' && (
        <RotateGizmo
          object={group}
          onDragEnd={() => onPositionChange([group.position.x, group.position.y, group.position.z])}
        />
      )}
      {group && isSelected && gizmoMode === 'scale' && (
        <ScaleGizmo
          object={group}
          onDragEnd={() => onPositionChange([group.position.x, group.position.y, group.position.z])}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 pointer-events-none">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      <p className="mt-4 text-sm">3D model will appear here</p>
    </div>
  )
}

function isViewer3DSplatWorkspacePath(workspacePath: string | undefined): workspacePath is string {
  return Boolean(
    workspacePath
    && isSafeViewerWorkspaceRelativePath(workspacePath)
    && /\.(ply|splat)$/i.test(workspacePath),
  )
}

function encodeViewer3DWorkspacePath(workspacePath: string): string {
  return workspacePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function resolveViewer3DSplatWorkspacePath(target: ViewerAssetTarget, modelUrl: string | null, apiUrl: string, workspaceDir?: string): string | undefined {
  if (!modelUrl || modelUrl.includes('#')) return undefined

  let candidate: string | undefined
  try {
    const parsed = new URL(modelUrl, apiUrl || 'http://localhost')
    if (parsed.username || parsed.password || (/^https?:\/\//.test(modelUrl)
      && (!apiUrl || parsed.origin !== new URL(apiUrl).origin))) return undefined
    // Preserve the visible source's raw path before URL normalization erases traversal.
    const rawPath = /^https?:\/\//.test(modelUrl)
      ? modelUrl.match(/^https?:\/\/[^/?#]+(\/[^?#]*)?(?:\?[^#]*)?$/)?.[1]
      : modelUrl.split('?', 1)[0]
    if (rawPath?.startsWith('/workspace/')) {
      const encoded = rawPath.slice('/workspace/'.length)
      if (encoded.split('/').some(segment => !segment || segment === '.' || segment === '..') || /%(?:2e|2f|5c|00|25)/i.test(encoded)) return undefined
      candidate = decodeURIComponent(encoded)
    } else if (rawPath === '/optimize/serve-file' && parsed.searchParams.getAll('path').length === 1) {
      const path = parsed.searchParams.get('path') ?? undefined
      candidate = isViewer3DSplatWorkspacePath(path) ? path
        : resolveViewerWorkspacePathFromAbsoluteValue(path, { workspaceDir })
    }
  } catch {
    return undefined
  }

  if (!isViewer3DSplatWorkspacePath(candidate)) return undefined
  // Optional target metadata corroborates, rather than replaces, the displayed source.
  return target.kind === 'none' || target.workspacePath === undefined || target.workspacePath === candidate ? candidate : undefined
}

function resolveViewer3DSplatUrl(apiUrl: string, workspacePath: string | undefined, modelUrl: string | null): string | null {
  if (!workspacePath) return modelUrl && /\.splat(?:$|[?#])/i.test(modelUrl) ? modelUrl : null
  if (/\.ply$/i.test(workspacePath)) {
    return `${apiUrl}/optimize/ply-to-splat?path=${encodeURIComponent(workspacePath)}`
  }
  if (/\.splat$/i.test(workspacePath)) {
    return `${apiUrl}/workspace/${encodeViewer3DWorkspacePath(workspacePath)}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Viewer3D
// ---------------------------------------------------------------------------

type Viewer3DPresentation = {
  modelUrl: string | null
  checkpointLabel: string | null
  sourceLabel: string | null
  provenance?: ArtifactRef['provenance']
  canDeleteSelectedModel: boolean
  selectedHint: string
  idleHint: string
}

type Viewer3DOverlayLayout = {
  viewRailClassName: string
  editRailClassName: string | null
  editPanelClassName: string
  rigEditorPanelSlot: 'top-right'
  motionRetargetPanelSlot: 'top-right-stack'
  motionRetargetPanelClassName: string
  poseClipPanelSlot: 'bottom-drawer'
  poseClipPanelClassName: string
  commonViewportUsability: 'capped-internal-scroll'
  hintClassName: string
  rigOverlayClassName: string
  rigOverlaySafeArea: 'below-top-left-toolbar' | 'above-minimized-pose-clip-controls'
}

type SceneEditSaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' | 'saved-unselected'; glbWorkspacePath: string; sidecarWorkspacePath: string }
  | { status: 'error'; message: string }

type RigRenameSaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; sidecarWorkspacePath: string }
  | { status: 'error'; message: string }

type HumanoidPromotionSaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; sidecarWorkspacePath: string }
  | { status: 'error'; message: string }

export type Viewer3DHumanoidReviewStateKind = 'trusted' | 'draft' | 'promoted' | 'stale' | 'diagnostics-only'

export type Viewer3DHumanoidProposedAssignments = {
  roles: Record<string, unknown>
  chains: Record<string, unknown>
}

export type Viewer3DHumanoidReviewPresentation = {
  state: Viewer3DHumanoidReviewStateKind
  headline: string
  canPromote: boolean
  diagnostics: string[]
}

type Viewer3DHumanoidReviewState = {
  meshWorkspacePath?: string
  trustedContractPresent: boolean
  draftResult?: HumanoidDraftSidecarReadResult
  promotionResult?: HumanoidPromotionSidecarReadResult
  proposedAssignments: Viewer3DHumanoidProposedAssignments
  proposalSourceDraftSha256?: string
  isProposalDirty: boolean
  rationale: string
  confirmationChecked: boolean
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  saveState: HumanoidPromotionSaveState
}

const DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY = 'modly:user:local:manual'
const DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY_LABEL = 'Local manual confirmation (not authenticated)'
const DEFAULT_VIEWER3D_HUMANOID_PROMOTION_RATIONALE = 'Manual confirmation from Rig Editor'
const EMPTY_HUMANOID_ASSIGNMENTS: Viewer3DHumanoidProposedAssignments = { roles: {}, chains: {} }

export type Viewer3DRigHydrationWarning = {
  status: 'warning'
  messages: string[]
}

export type Viewer3DRigHydrationToken = {
  modelUrl: string | null
  sourceWorkspacePath: string
  semanticSourceWorkspacePath: string
  skeletonContextId: string
}

export interface Viewer3DSemanticHydrationSource {
  displayedMeshWorkspacePath: string
  semanticSourceWorkspacePath: string
  sourceKind: 'displayed-mesh' | 'kimodo-source'
  warnings: string[]
  failedClosed: boolean
}

export interface Viewer3DRigEditorState {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  renamePlan: RigRenamePlan
  rigMetaNamingByBoneId: RigMetaNamingMap
  isRenamePlanDirty?: boolean
}

type Viewer3DRigEditorPanelOptions = {
  rigMetaNamingByBoneId?: RigMetaNamingMap
  humanoidReview?: RigEditorHumanoidReviewProps
}

export interface Viewer3DRigEditorVisibilityState {
  isOpen: boolean
  skeletonContextId?: string
}

export interface Viewer3DPoseClipState {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  selectedKeyframeId?: string
  plan: PoseClipPlan
  currentTimeSeconds: number
  previewState: PoseClipPreviewState
  saveState: PoseClipSaveState
  loadState: PoseClipLoadState
  warning: Viewer3DRigHydrationWarning | null
  saveError?: string
  loadError?: string
}

export interface Viewer3DPoseClipVisibilityState {
  isOpen: boolean
  skeletonContextId?: string
  drawerMode: PoseClipDrawerMode
}

export interface Viewer3DMotionRetargetState {
  summary?: RigSkeletonSummary
  session?: MotionRetargetSession
  identity?: MotionRetargetCorrectionIdentityV1
  corrections: MotionRetargetCorrectionsV1
  correctionState: ReturnType<typeof resolveMotionRetargetCorrectionState>
  selectedSourceBoneId?: string
  diagnosticsMessages: string[]
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  exportState: 'idle' | 'exporting' | 'exported' | 'error'
  previewState: 'idle' | 'playing' | 'paused'
  previewCurrentTimeSeconds: number
  saveMessage?: string
  loadMessage?: string
  exportMessage?: string
}

export interface Viewer3DMotionRetargetVisibilityState {
  isOpen: boolean
  skeletonContextId?: string
}

export type Viewer3DMotionRetargetArtifactEntry = {
  key: MotionRetargetArtifactLink['key']
  label: MotionRetargetArtifactLink['label']
  workspacePath: MotionRetargetArtifactLink['workspacePath']
  downloadName?: MotionRetargetArtifactLink['downloadName']
  openMode: 'viewer3d-preview' | 'workspace-preview'
}

export type Viewer3DKimodoSourceRigFallbackResult = {
  active: boolean
  modelUrl: string | null
  sourceWorkspacePath?: string
  warnings: string[]
  artifact?: KimodoMotionArtifact
  trust?: {
    trustedContractPresent: false
    trustedEvidence: {
      sourceContract: false
      basis: false
      axis: false
      plane: false
      motion: false
    }
  }
}

export type Viewer3DAuthoringPresentation = {
  modelUrl: string | null
  rigSourceWorkspacePath?: string
  resetKey: { currentJobId?: string, baseModelUrl: string | null }
  warnings: string[]
}

export type Viewer3DArtifactPreviewState =
  | { status: 'closed' }
  | {
      status: 'text'
      title: string
      workspacePath: string
      displayName: string
      content: string
      byteLength: number
      truncated: boolean
    }
  | {
      status: 'audio'
      title: string
      workspacePath: string
      displayName: string
      byteLength: number
      audioKind: 'wav' | 'mp3' | 'ogg' | 'flac'
      sourceUrl: string
    }
  | {
      status: 'binary'
      title: string
      workspacePath: string
      displayName: string
      byteLength: number
      binaryKind: string
      message: string
    }

export interface Viewer3DSelectedRigTargetState {
  skeletonContextId?: string
  selectedBoneId?: RigBoneId
}

export type Viewer3DRigAuthoringMode = 'rig-editor' | 'pose-clip' | 'none'

export interface Viewer3DRigTargetState {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  activeMode: Viewer3DRigAuthoringMode
}

export type Viewer3DPoseClipAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'select-bone'; summary: RigSkeletonSummary; boneId: RigBoneId }
  | { type: 'set-current-time'; timeSeconds: number }
  | { type: 'set-clip-metadata'; summary: RigSkeletonSummary; durationSeconds?: number; fps?: number; name?: string; id?: string }
  | { type: 'hydrate-plan'; plan: PoseClipPlan }
  | { type: 'capture-keyframe'; summary: RigSkeletonSummary; keyframeId?: string; boneId: RigBoneId; timeSeconds: number; rotation: PoseClipQuaternion }
  | { type: 'capture-and-advance'; summary: RigSkeletonSummary; boneId: RigBoneId; rotation: PoseClipQuaternion }
  | { type: 'select-keyframe'; summary: RigSkeletonSummary; keyframeId: string }
  | { type: 'update-selected-keyframe'; summary: RigSkeletonSummary; boneId: RigBoneId; rotation: PoseClipQuaternion }
  | { type: 'delete-keyframe'; summary: RigSkeletonSummary; keyframeId: string }
  | { type: 'delete-selected-keyframe'; summary: RigSkeletonSummary }
  | { type: 'move-selected-keyframe'; summary: RigSkeletonSummary; timeSeconds: number }
  | { type: 'shift-selected-keyframe'; summary: RigSkeletonSummary; deltaSeconds: number }
  | { type: 'duplicate-selected-keyframe'; summary: RigSkeletonSummary; timeSeconds?: number }
  | { type: 'set-preview'; previewState: PoseClipPreviewState; currentTimeSeconds?: number }
  | { type: 'reset-preview' }

export type Viewer3DPoseClipVisibilityAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'toggle'; summary?: RigSkeletonSummary }
  | { type: 'set-drawer-mode'; drawerMode: PoseClipDrawerMode }
  | { type: 'close' }

export type Viewer3DMotionRetargetAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'set-session'; session?: MotionRetargetSession }
  | { type: 'select-source-bone'; sourceBoneId?: string }
  | { type: 'set-mapping'; sourceBoneId: string; targetBoneId?: RigBoneId }
  | { type: 'set-preview'; selectedPreview: MotionRetargetPreviewKind }
  | { type: 'set-corrections'; corrections: Partial<MotionRetargetCorrectionsV1> }
  | { type: 'set-preview-time'; timeSeconds: number }
  | { type: 'set-preview-state'; previewState: 'idle' | 'playing' | 'paused'; timeSeconds?: number }

export type Viewer3DMotionRetargetVisibilityAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'toggle'; summary?: RigSkeletonSummary }
  | { type: 'close' }

export type Viewer3DRigEditorAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'hydrate-aliases'; plan: RigRenamePlan }
  | { type: 'select-bone'; boneId: RigBoneId }
  | { type: 'set-alias'; boneId: RigBoneId; alias: string }
  | { type: 'cancel-alias'; boneId: RigBoneId }
  | { type: 'revert-aliases' }

export type Viewer3DRigEditorVisibilityAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'toggle'; summary?: RigSkeletonSummary }
  | { type: 'close' }

export type Viewer3DSelectedRigTargetAction =
  | { type: 'set-summary'; summary?: RigSkeletonSummary }
  | { type: 'select-bone'; summary: RigSkeletonSummary; boneId: RigBoneId }

type Viewer3DRigEditorCallbacks = {
  onSelectBone?: (boneId: RigBoneId) => void
  onAliasChange?: (boneId: RigBoneId, alias: string) => void
  onCancelAlias?: (boneId: RigBoneId) => void
  onRevertAliases?: () => void
  onSaveAliases?: () => void
}

type Viewer3DRigOverlayCallbacks = {
  onSelectBone?: (boneId: RigBoneId) => void
}

const EMPTY_RIG_RENAME_PLAN: RigRenamePlan = { skeletonContextId: 'rig:none|skeleton:0', aliases: {} }
const EMPTY_RIG_META_NAMING: RigMetaNamingMap = {}

export function createViewer3DRigEditorState(summary?: RigSkeletonSummary): Viewer3DRigEditorState {
  if (!summary) {
    return { summary, selectedBoneId: undefined, renamePlan: EMPTY_RIG_RENAME_PLAN, rigMetaNamingByBoneId: EMPTY_RIG_META_NAMING }
  }

  return {
    summary,
    selectedBoneId: undefined,
    renamePlan: createRigRenamePlan(summary),
    rigMetaNamingByBoneId: EMPTY_RIG_META_NAMING,
    isRenamePlanDirty: false,
  }
}

export function createViewer3DRigEditorVisibilityState(summary?: RigSkeletonSummary): Viewer3DRigEditorVisibilityState {
  return { isOpen: false, skeletonContextId: summary?.skeletonContextId }
}

export function createViewer3DPoseClipState(summary?: RigSkeletonSummary): Viewer3DPoseClipState {
  const plan = createPoseClipPlan({ skeletonContextId: summary?.skeletonContextId ?? 'rig:none|skeleton:0' })
  return {
    summary,
    selectedBoneId: undefined,
    plan,
    currentTimeSeconds: 0,
    previewState: 'idle',
    saveState: 'idle',
    loadState: 'idle',
    warning: null,
  }
}

export function createViewer3DPoseClipVisibilityState(summary?: RigSkeletonSummary): Viewer3DPoseClipVisibilityState {
  return { isOpen: false, skeletonContextId: summary?.skeletonContextId, drawerMode: 'minimized' }
}

export function createViewer3DMotionRetargetState(summary?: RigSkeletonSummary, session?: MotionRetargetSession): Viewer3DMotionRetargetState {
  const localSession = canonicalViewer3DMotionRetargetSession(summary, session)
  const identity = createViewer3DMotionRetargetCorrectionIdentity({ summary, session: localSession })
  return {
    summary,
    session: localSession,
    identity,
    corrections: structuredClone(DEFAULT_MOTION_RETARGET_CORRECTIONS),
    correctionState: resolveMotionRetargetCorrectionState({ status: 'idle' }),
    selectedSourceBoneId: localSession?.sourceBones[0]?.sourceBoneId,
    diagnosticsMessages: [],
    saveState: 'idle',
    loadState: 'idle',
    exportState: 'idle',
    previewState: 'idle',
    previewCurrentTimeSeconds: 0,
  }
}

export function createViewer3DMotionRetargetVisibilityState(summary?: RigSkeletonSummary): Viewer3DMotionRetargetVisibilityState {
  return { isOpen: false, skeletonContextId: summary?.skeletonContextId }
}

export function createViewer3DSelectedRigTargetState(summary?: RigSkeletonSummary): Viewer3DSelectedRigTargetState {
  return {
    skeletonContextId: summary?.skeletonContextId,
    selectedBoneId: resolveDefaultRigSelectedBoneId(summary),
  }
}

export function reduceViewer3DSelectedRigTargetState(
  state: Viewer3DSelectedRigTargetState,
  action: Viewer3DSelectedRigTargetAction,
): Viewer3DSelectedRigTargetState {
  if (action.type === 'select-bone') {
    if (!action.summary.hasRig) return createViewer3DSelectedRigTargetState(action.summary)
    const selectedBoneId = action.summary.bones.some((bone) => bone.boneId === action.boneId)
      ? action.boneId
      : resolveValidRigSelectedBoneId(action.summary, state.selectedBoneId)
    return { skeletonContextId: action.summary.skeletonContextId, selectedBoneId }
  }

  const skeletonContextId = action.summary?.skeletonContextId
  if (state.skeletonContextId === skeletonContextId) {
    return {
      skeletonContextId,
      selectedBoneId: resolveValidRigSelectedBoneId(action.summary, state.selectedBoneId),
    }
  }
  return createViewer3DSelectedRigTargetState(action.summary)
}

export function reduceViewer3DPoseClipVisibilityState(
  state: Viewer3DPoseClipVisibilityState,
  action: Viewer3DPoseClipVisibilityAction,
): Viewer3DPoseClipVisibilityState {
  if (action.type === 'close') return { ...state, isOpen: false }
  if (action.type === 'set-drawer-mode') return { ...state, drawerMode: action.drawerMode }
  const skeletonContextId = action.summary?.skeletonContextId
  if (action.type === 'set-summary') {
    if (state.skeletonContextId !== skeletonContextId) return createViewer3DPoseClipVisibilityState(action.summary)
    return { ...state, skeletonContextId }
  }
  if (!action.summary?.hasRig) return { skeletonContextId, isOpen: false, drawerMode: state.drawerMode }
  return { skeletonContextId, isOpen: !state.isOpen, drawerMode: state.drawerMode }
}

export function reduceViewer3DPoseClipState(
  state: Viewer3DPoseClipState,
  action: Viewer3DPoseClipAction,
): Viewer3DPoseClipState {
  if (action.type === 'set-summary') {
    if (state.summary?.skeletonContextId === action.summary?.skeletonContextId) {
      const selectedBoneId = state.selectedBoneId && action.summary?.bones.some((bone) => bone.boneId === state.selectedBoneId)
        ? state.selectedBoneId
        : undefined
      const selectedKeyframeId = state.selectedKeyframeId && state.plan.keyframes.some((keyframe) => keyframe.id === state.selectedKeyframeId)
        ? state.selectedKeyframeId
        : undefined
      return { ...state, summary: action.summary, selectedBoneId, selectedKeyframeId, plan: { ...state.plan, skeletonContextId: action.summary?.skeletonContextId ?? state.plan.skeletonContextId } }
    }
    return createViewer3DPoseClipState(action.summary)
  }

  if (action.type === 'hydrate-plan') {
    return { ...state, plan: action.plan, selectedBoneId: action.plan.selectedBoneId ?? state.selectedBoneId, selectedKeyframeId: undefined, currentTimeSeconds: clampPoseClipTime(state.currentTimeSeconds, action.plan.clip.durationSeconds), loadState: 'loaded', warning: null, loadError: undefined }
  }

  if (action.type === 'set-current-time') {
    return { ...state, currentTimeSeconds: clampPoseClipTime(action.timeSeconds, state.plan.clip.durationSeconds) }
  }

  if (action.type === 'set-clip-metadata') {
    const nextPlan = reducePoseClipPlan(action.summary, state.plan, {
      type: 'set-clip-metadata',
      durationSeconds: action.durationSeconds,
      fps: action.fps,
      name: action.name,
      id: action.id,
    })
    const selectedKeyframe = state.selectedKeyframeId
      ? nextPlan.keyframes.find((keyframe) => keyframe.id === state.selectedKeyframeId)
      : undefined
    return {
      ...state,
      summary: action.summary,
      plan: nextPlan,
      currentTimeSeconds: clampPoseClipTime(state.currentTimeSeconds, nextPlan.clip.durationSeconds),
      selectedKeyframeId: selectedKeyframe?.id,
    }
  }

  if (action.type === 'set-preview') {
    return { ...state, previewState: action.previewState, currentTimeSeconds: action.currentTimeSeconds ?? state.currentTimeSeconds }
  }

  if (action.type === 'reset-preview') {
    return { ...state, previewState: 'idle', currentTimeSeconds: 0 }
  }

  if (action.type === 'select-bone') {
    return {
      ...state,
      summary: action.summary,
      selectedBoneId: action.boneId,
      plan: reducePoseClipPlan(action.summary, state.plan, { type: 'select-bone', boneId: action.boneId }),
    }
  }

  if (action.type === 'select-keyframe') {
    const keyframe = state.plan.keyframes.find((candidate) => candidate.id === action.keyframeId)
    if (!keyframe || !action.summary.bones.some((bone) => bone.boneId === keyframe.boneId)) {
      return { ...state, summary: action.summary, selectedKeyframeId: undefined }
    }
    const selectedPlan = reducePoseClipPlan(action.summary, state.plan, { type: 'select-bone', boneId: keyframe.boneId })
    return {
      ...state,
      summary: action.summary,
      selectedBoneId: keyframe.boneId,
      selectedKeyframeId: keyframe.id,
      currentTimeSeconds: clampPoseClipTime(keyframe.timeSeconds, state.plan.clip.durationSeconds),
      plan: selectedPlan,
      previewState: state.previewState === 'playing' ? 'paused' : state.previewState,
    }
  }

  if (action.type === 'delete-keyframe') {
    return {
      ...state,
      plan: reducePoseClipPlan(action.summary, state.plan, { type: 'delete-keyframe', keyframeId: action.keyframeId }),
      selectedKeyframeId: state.selectedKeyframeId === action.keyframeId ? undefined : state.selectedKeyframeId,
    }
  }

  if (action.type === 'delete-selected-keyframe') {
    if (!state.selectedKeyframeId) return state
    return {
      ...state,
      summary: action.summary,
      plan: reducePoseClipPlan(action.summary, state.plan, { type: 'delete-keyframe', keyframeId: state.selectedKeyframeId }),
      selectedKeyframeId: undefined,
    }
  }

  if (action.type === 'update-selected-keyframe') {
    if (!state.selectedKeyframeId || !action.summary.bones.some((bone) => bone.boneId === action.boneId)) return state
    const selectedPlan = reducePoseClipPlan(action.summary, state.plan, { type: 'select-bone', boneId: action.boneId })
    const nextPlan = reducePoseClipPlan(action.summary, selectedPlan, {
      type: 'update-keyframe',
      keyframeId: state.selectedKeyframeId,
      timeSeconds: state.currentTimeSeconds,
      rotation: action.rotation,
    })
    const updatedKeyframe = nextPlan.keyframes.find((keyframe) => keyframe.id === state.selectedKeyframeId)
    if (!updatedKeyframe) return { ...state, summary: action.summary, selectedKeyframeId: undefined, plan: nextPlan }
    return {
      ...state,
      summary: action.summary,
      selectedBoneId: action.boneId,
      selectedKeyframeId: updatedKeyframe.id,
      currentTimeSeconds: updatedKeyframe.timeSeconds,
      plan: nextPlan,
      previewState: state.previewState === 'playing' ? 'paused' : state.previewState,
    }
  }

  if (action.type === 'move-selected-keyframe' || action.type === 'shift-selected-keyframe') {
    if (!state.selectedKeyframeId) return state
    const nextPlan = reducePoseClipPlan(action.summary, state.plan, action.type === 'move-selected-keyframe'
      ? { type: 'move-keyframe', keyframeId: state.selectedKeyframeId, timeSeconds: action.timeSeconds }
      : { type: 'shift-keyframe', keyframeId: state.selectedKeyframeId, deltaSeconds: action.deltaSeconds })
    const selectedKeyframe = nextPlan.keyframes.find((keyframe) => keyframe.id === state.selectedKeyframeId)
    if (!selectedKeyframe) return { ...state, summary: action.summary, selectedKeyframeId: undefined, plan: nextPlan }
    return {
      ...state,
      summary: action.summary,
      selectedBoneId: selectedKeyframe.boneId,
      selectedKeyframeId: selectedKeyframe.id,
      currentTimeSeconds: selectedKeyframe.timeSeconds,
      plan: nextPlan,
      previewState: state.previewState === 'playing' ? 'paused' : state.previewState,
    }
  }

  if (action.type === 'duplicate-selected-keyframe') {
    if (!state.selectedKeyframeId) return state
    const beforeIds = new Set(state.plan.keyframes.map((keyframe) => keyframe.id))
    const nextPlan = reducePoseClipPlan(action.summary, state.plan, { type: 'duplicate-keyframe', keyframeId: state.selectedKeyframeId, timeSeconds: action.timeSeconds })
    const duplicate = nextPlan.keyframes.find((keyframe) => !beforeIds.has(keyframe.id))
    if (!duplicate) return { ...state, summary: action.summary, plan: nextPlan, selectedKeyframeId: undefined }
    return {
      ...state,
      summary: action.summary,
      selectedBoneId: duplicate.boneId,
      selectedKeyframeId: duplicate.id,
      currentTimeSeconds: duplicate.timeSeconds,
      plan: reducePoseClipPlan(action.summary, nextPlan, { type: 'select-bone', boneId: duplicate.boneId }),
      previewState: state.previewState === 'playing' ? 'paused' : state.previewState,
    }
  }

  if (action.type === 'capture-and-advance') {
    if (!action.summary.bones.some((bone) => bone.boneId === action.boneId)) return state
    const captureTime = clampPoseClipTime(state.currentTimeSeconds, state.plan.clip.durationSeconds)
    const selectedPlan = reducePoseClipPlan(action.summary, state.plan, { type: 'select-bone', boneId: action.boneId })
    const keyframeId = createPoseClipCaptureKeyframeId(selectedPlan, action.boneId, captureTime)
    const nextPlan = reducePoseClipPlan(action.summary, selectedPlan, {
      type: 'capture-keyframe',
      keyframeId,
      timeSeconds: captureTime,
      rotation: action.rotation,
    })
    return {
      ...state,
      summary: action.summary,
      selectedBoneId: action.boneId,
      selectedKeyframeId: keyframeId,
      currentTimeSeconds: clampPoseClipTime(captureTime + 1 / Math.max(nextPlan.clip.fps, 1), nextPlan.clip.durationSeconds),
      plan: nextPlan,
      previewState: state.previewState === 'playing' ? 'paused' : state.previewState,
    }
  }

  const captureTime = clampPoseClipTime(action.timeSeconds, state.plan.clip.durationSeconds)
  const selectedPlan = reducePoseClipPlan(action.summary, state.plan, { type: 'select-bone', boneId: action.boneId })
  const keyframeId = action.keyframeId ?? createPoseClipCaptureKeyframeId(selectedPlan, action.boneId, captureTime)
  return {
    ...state,
    summary: action.summary,
    selectedBoneId: action.boneId,
    currentTimeSeconds: captureTime,
    selectedKeyframeId: keyframeId,
    plan: reducePoseClipPlan(action.summary, selectedPlan, {
      type: 'capture-keyframe',
      keyframeId,
      timeSeconds: captureTime,
      rotation: action.rotation,
    }),
  }
}

export function reduceViewer3DMotionRetargetVisibilityState(
  state: Viewer3DMotionRetargetVisibilityState,
  action: Viewer3DMotionRetargetVisibilityAction,
): Viewer3DMotionRetargetVisibilityState {
  if (action.type === 'close') return { ...state, isOpen: false }

  const skeletonContextId = action.summary?.skeletonContextId
  if (action.type === 'set-summary') {
    if (state.skeletonContextId !== skeletonContextId) return createViewer3DMotionRetargetVisibilityState(action.summary)
    if (!action.summary?.hasRig) return { skeletonContextId, isOpen: false }
    return { ...state, skeletonContextId }
  }

  if (!action.summary?.hasRig) return { skeletonContextId, isOpen: false }
  return { skeletonContextId, isOpen: !state.isOpen }
}

export function reduceViewer3DMotionRetargetState(
  state: Viewer3DMotionRetargetState,
  action: Viewer3DMotionRetargetAction,
): Viewer3DMotionRetargetState {
  if (action.type === 'set-summary') {
    if (state.summary?.skeletonContextId === action.summary?.skeletonContextId) return { ...state, summary: action.summary }
    return createViewer3DMotionRetargetState(action.summary)
  }

  if (action.type === 'set-session') {
      const session = canonicalViewer3DMotionRetargetSession(state.summary, action.session)
      const identity = createViewer3DMotionRetargetCorrectionIdentity({ summary: state.summary, session })
      if (identity?.key !== state.identity?.key) return createViewer3DMotionRetargetState(state.summary, session)
      return {
        ...state,
        session,
        identity,
        corrections: state.corrections,
        correctionState: state.correctionState,
        selectedSourceBoneId: session?.sourceBones.some((bone) => bone.sourceBoneId === state.selectedSourceBoneId)
          ? state.selectedSourceBoneId
          : session?.sourceBones[0]?.sourceBoneId,
        diagnosticsMessages: state.diagnosticsMessages,
        saveState: state.saveState,
        loadState: state.loadState,
        exportState: state.exportState,
        previewState: state.previewState,
        previewCurrentTimeSeconds: state.previewCurrentTimeSeconds,
        saveMessage: state.saveMessage,
        loadMessage: state.loadMessage,
        exportMessage: state.exportMessage,
      }
    }

  if (!state.session) return state

  if (action.type === 'select-source-bone') {
    const selectedSourceBoneId = action.sourceBoneId && state.session.sourceBones.some((bone) => bone.sourceBoneId === action.sourceBoneId)
      ? action.sourceBoneId
      : state.selectedSourceBoneId
    return { ...state, selectedSourceBoneId }
  }

  if (action.type === 'set-mapping') {
    const session = action.targetBoneId === undefined
      ? reduceMotionRetargetSession(state.session, { type: 'clear-mapping', sourceBoneId: action.sourceBoneId })
      : reduceMotionRetargetSession(state.session, { type: 'set-mapping', sourceBoneId: action.sourceBoneId, targetBoneId: action.targetBoneId })
    const selectedSourceBoneId = session.sourceBones.some((bone) => bone.sourceBoneId === action.sourceBoneId)
      ? action.sourceBoneId
      : state.selectedSourceBoneId
    return {
      ...state,
      session,
      selectedSourceBoneId,
      correctionState: resolveMotionRetargetCorrectionState({ status: 'dirty', lastLoadedIdentityKey: state.identity?.key, currentIdentityKey: state.identity?.key }),
    }
  }

  if (action.type === 'set-preview-time') {
    const preview = resolveViewer3DMotionRetargetPreviewClip(state)
    return {
      ...state,
      previewCurrentTimeSeconds: clampPoseClipTime(action.timeSeconds, preview.plan?.clip.durationSeconds ?? 0),
    }
  }

  if (action.type === 'set-preview-state') {
    return {
      ...state,
      previewState: action.previewState,
      previewCurrentTimeSeconds: action.timeSeconds ?? state.previewCurrentTimeSeconds,
    }
  }

  if (action.type === 'set-corrections') {
    return {
      ...state,
      corrections: normalizeMotionRetargetCorrections(action.corrections),
      correctionState: resolveMotionRetargetCorrectionState({ status: 'dirty', lastLoadedIdentityKey: state.identity?.key, currentIdentityKey: state.identity?.key }),
    }
  }

  return {
    ...state,
    session: reduceMotionRetargetSession(state.session, { type: 'set-preview', selectedPreview: action.selectedPreview }),
    correctionState: resolveMotionRetargetCorrectionState({ status: 'dirty', lastLoadedIdentityKey: state.identity?.key, currentIdentityKey: state.identity?.key }),
  }
}

export function reduceViewer3DRigEditorVisibilityState(
  state: Viewer3DRigEditorVisibilityState,
  action: Viewer3DRigEditorVisibilityAction,
): Viewer3DRigEditorVisibilityState {
  if (action.type === 'close') return { ...state, isOpen: false }

  const skeletonContextId = action.summary?.skeletonContextId
  if (action.type === 'set-summary') {
    if (state.skeletonContextId !== skeletonContextId) return createViewer3DRigEditorVisibilityState(action.summary)
    if (!action.summary?.hasRig) return { skeletonContextId, isOpen: false }
    return { ...state, skeletonContextId }
  }

  if (!action.summary?.hasRig) return { skeletonContextId, isOpen: false }
  return { skeletonContextId, isOpen: !state.isOpen }
}

export function reduceViewer3DRigEditorState(
  state: Viewer3DRigEditorState,
  action: Viewer3DRigEditorAction,
): Viewer3DRigEditorState {
  if (action.type === 'set-summary') {
    if (state.summary?.skeletonContextId === action.summary?.skeletonContextId) {
      return preserveValidRigSelection({ ...state, summary: action.summary })
    }
    return createViewer3DRigEditorState(action.summary)
  }

  const summary = state.summary
  if (!summary?.hasRig) return state

  if (action.type === 'hydrate-aliases') {
    return { ...state, renamePlan: action.plan, isRenamePlanDirty: false }
  }

  if (action.type === 'select-bone') {
    const selectedBoneId = summary.bones.some((bone) => bone.boneId === action.boneId)
      ? action.boneId
      : state.selectedBoneId
    return { ...state, selectedBoneId }
  }

  if (action.type === 'revert-aliases') {
    return { ...state, renamePlan: reduceRigRenamePlan(summary, state.renamePlan, { type: 'revert-all' }), isRenamePlanDirty: true }
  }

  if (action.type === 'cancel-alias') {
    return { ...state, renamePlan: reduceRigRenamePlan(summary, state.renamePlan, action), isRenamePlanDirty: true }
  }

  return { ...state, renamePlan: reduceRigRenamePlan(summary, state.renamePlan, action), isRenamePlanDirty: true }
}

export function resolveViewer3DRigEditorPanelProps(
  state: Viewer3DRigEditorState,
  callbacks: Viewer3DRigEditorCallbacks,
  hydrationWarning?: Viewer3DRigHydrationWarning | null,
  options?: Viewer3DRigEditorPanelOptions,
): {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  renamePlan: RigRenamePlan
  rigMetaNamingByBoneId: RigMetaNamingMap
  effectiveNaming?: RigEffectiveNamingResult
  humanoidReview?: RigEditorHumanoidReviewProps
  validation: RigRenameValidationResult
  hydrationWarning?: Viewer3DRigHydrationWarning | null
  onSelectBone: (boneId: RigBoneId) => void
  onAliasChange: (boneId: RigBoneId, alias: string) => void
  onCancelAlias: (boneId: RigBoneId) => void
  onRevertAliases: () => void
  onSaveAliases: () => void
} {
  const rigMetaNamingByBoneId = options?.rigMetaNamingByBoneId ?? state.rigMetaNamingByBoneId
  return {
    summary: state.summary,
    selectedBoneId: state.selectedBoneId,
    renamePlan: state.renamePlan,
    rigMetaNamingByBoneId,
    effectiveNaming: state.summary?.hasRig ? resolveRigEffectiveNaming(state.summary, state.renamePlan, rigMetaNamingByBoneId) : undefined,
    humanoidReview: options?.humanoidReview,
    validation: state.summary?.hasRig ? validateRigRenamePlan(state.summary, state.renamePlan) : { valid: true, errors: [] },
    hydrationWarning,
    onSelectBone: callbacks.onSelectBone ?? (() => undefined),
    onAliasChange: callbacks.onAliasChange ?? (() => undefined),
    onCancelAlias: callbacks.onCancelAlias ?? (() => undefined),
    onRevertAliases: callbacks.onRevertAliases ?? (() => undefined),
    onSaveAliases: callbacks.onSaveAliases ?? (() => undefined),
  }
}

function isHumanoidDraftReadable(result?: HumanoidDraftSidecarReadResult): result is Extract<HumanoidDraftSidecarReadResult, { success: true; status: 'found' | 'stale' }> {
  return result?.success === true && (result.status === 'found' || result.status === 'stale')
}

function isHumanoidPromotionReadable(result?: HumanoidPromotionSidecarReadResult): result is Extract<HumanoidPromotionSidecarReadResult, { success: true; status: 'found' | 'stale' }> {
  return result?.success === true && (result.status === 'found' || result.status === 'stale')
}

function mergeViewer3DRigDisplayNaming(
  baseNamingByBoneId: RigMetaNamingMap,
  overlayNamingByBoneId: RigMetaNamingMap,
): RigMetaNamingMap {
  const merged: RigMetaNamingMap = { ...baseNamingByBoneId }
  for (const [boneId, entry] of Object.entries(overlayNamingByBoneId)) {
    if (merged[boneId]?.source === 'humanoid_contract') continue
    merged[boneId as RigBoneId] = entry
  }
  return merged
}

export function resolveViewer3DEffectiveRigMetaNaming({
  summary,
  rigMetaNamingByBoneId,
  draftResult,
  promotionResult,
}: {
  summary?: RigSkeletonSummary
  rigMetaNamingByBoneId: RigMetaNamingMap
  draftResult?: HumanoidDraftSidecarReadResult
  promotionResult?: HumanoidPromotionSidecarReadResult
}): RigMetaNamingMap {
  let merged = { ...rigMetaNamingByBoneId }
  if (isHumanoidDraftReadable(draftResult)) {
    const draftNaming = summary?.hasRig
      ? translateHumanoidAssignmentsToRigMetaNaming({
        summary,
        sources: [{ source: 'humanoid_draft', roleMap: draftResult.sidecar.assignments }],
      }).namingByBoneId
      : createRigMetaNamingFromHumanoidAssignments(draftResult.sidecar.assignments.roles, 'humanoid_draft')
    merged = mergeViewer3DRigDisplayNaming(merged, draftNaming)
  }
  if (isHumanoidPromotionReadable(promotionResult)) {
    const promotionNaming = summary?.hasRig
      ? translateHumanoidAssignmentsToRigMetaNaming({
        summary,
        sources: [{ source: 'humanoid_promotion', roleMap: promotionResult.sidecar.promotedAssignments }],
      }).namingByBoneId
      : createRigMetaNamingFromHumanoidAssignments(promotionResult.sidecar.promotedAssignments.roles, 'humanoid_promotion')
    merged = mergeViewer3DRigDisplayNaming(merged, promotionNaming)
  }
  return merged
}

export function resolveViewer3DHumanoidReviewPresentationForHydrationSource({
  presentation,
  semanticHydrationSource,
}: {
  presentation: Viewer3DHumanoidReviewPresentation
  semanticHydrationSource?: Viewer3DSemanticHydrationSource
}): Viewer3DHumanoidReviewPresentation {
  if (semanticHydrationSource?.sourceKind !== 'kimodo-source') return presentation
  return {
    ...presentation,
    canPromote: false,
  }
}

export function resolveViewer3DRigHumanoidReviewProps(props: RigEditorHumanoidReviewProps): RigEditorHumanoidReviewProps {
  return {
    presentation: props.presentation,
    saveState: props.saveState,
    onPromote: props.onPromote,
  }
}

export function resolveViewer3DHumanoidPromotionButtonAudit(args?: {
  rationale?: string
  confirmationChecked?: boolean
}): {
  rationale: string
  confirmationChecked: true
} {
  return {
    rationale: args?.rationale?.trim() ? args.rationale.trim() : DEFAULT_VIEWER3D_HUMANOID_PROMOTION_RATIONALE,
    confirmationChecked: true,
  }
}

export function resolveViewer3DRigEditorPanelRenderState({
  modelUrl,
  rigState,
  visibility,
}: {
  modelUrl: string | null
  rigState: Viewer3DRigEditorState
  visibility: Viewer3DRigEditorVisibilityState
}): { shouldRenderPanel: boolean } {
  return { shouldRenderPanel: Boolean(modelUrl && rigState.summary && visibility.isOpen) }
}

export function resolveViewer3DPoseClipPanelRenderState({
  modelUrl,
  poseState,
  visibility,
}: {
  modelUrl: string | null
  poseState: Viewer3DPoseClipState
  visibility: Viewer3DPoseClipVisibilityState
}): { shouldRenderPanel: boolean } {
  return { shouldRenderPanel: Boolean(modelUrl && poseState.summary && visibility.isOpen) }
}

export function resolveViewer3DMotionRetargetPanelRenderState({
  modelUrl,
  motionRetargetState,
  visibility,
}: {
  modelUrl: string | null
  motionRetargetState: Viewer3DMotionRetargetState
  visibility: Viewer3DMotionRetargetVisibilityState
}): { shouldRenderPanel: boolean } {
  void modelUrl
  void motionRetargetState
  void visibility
  return { shouldRenderPanel: false }
}

type Viewer3DMotionRetargetCallbacks = {
  onSelectSourceBone?: (sourceBoneId: string) => void
  onChangeMapping?: (sourceBoneId: string, targetBoneId?: RigBoneId) => void
  onSelectPreview?: (selectedPreview: MotionRetargetPreviewKind) => void
  onSaveSidecar?: () => void
  onLoadSidecar?: () => void
  onExportPoseClipCompanion?: () => void
  onOpenArtifact?: (artifact: MotionRetargetArtifactLink) => void
  onDownloadArtifact?: (artifact: MotionRetargetArtifactLink) => void
  onPlayPreview?: () => void
  onPausePreview?: () => void
  onResetPreview?: () => void
  onScrubPreview?: (timeSeconds: number) => void
  onChangeCorrections?: (corrections: MotionRetargetCorrectionsV1) => void
  onToggleAnimationPlayback?: () => void
}

type Viewer3DMotionRetargetPanelOptions = {
  animationPlaybackAvailable?: boolean
  animationPlaybackActive?: boolean
  fallbackArtifact?: KimodoMotionArtifact
  warnings?: readonly string[]
}

export function resolveViewer3DMotionRetargetPanelProps(
  state: Viewer3DMotionRetargetState,
  callbacks: Viewer3DMotionRetargetCallbacks,
  options: Viewer3DMotionRetargetPanelOptions = {},
): {
  summary?: RigSkeletonSummary
  session?: MotionRetargetSession
  selectedSourceBoneId?: string
  selectedMapping?: MotionRetargetMappingEntry
  warnings: string[]
  saveDisabledReason?: string
  exportDisabledReason?: string
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  exportState: 'idle' | 'exporting' | 'exported' | 'error'
  previewState: 'idle' | 'playing' | 'paused'
  previewDisabledReason?: string
  previewCurrentTimeSeconds: number
  previewDurationSeconds: number
  corrections: MotionRetargetCorrectionsV1
  correctionMessage?: string
  correctionDirty: boolean
  animationPlaybackAvailable: boolean
  animationPlaybackActive: boolean
  artifactLinks: Viewer3DMotionRetargetArtifactEntry[]
  saveMessage?: string
  loadMessage?: string
  exportMessage?: string
  onSelectSourceBone: (sourceBoneId: string) => void
  onChangeMapping: (sourceBoneId: string, targetBoneId?: RigBoneId) => void
  onSelectPreview: (selectedPreview: MotionRetargetPreviewKind) => void
    onSaveSidecar: () => void
    onLoadSidecar: () => void
    onExportPoseClipCompanion: () => void
    onOpenArtifact: (artifact: MotionRetargetArtifactLink) => void
    onDownloadArtifact: (artifact: MotionRetargetArtifactLink) => void
    onPlayPreview: () => void
  onPausePreview: () => void
  onResetPreview: () => void
  onScrubPreview: (timeSeconds: number) => void
  onChangeCorrections: (corrections: MotionRetargetCorrectionsV1) => void
  onToggleAnimationPlayback: () => void
} {
  state = { ...state, session: canonicalViewer3DMotionRetargetSession(state.summary, state.session) }
  const selectedSourceBoneId = state.selectedSourceBoneId ?? state.session?.sourceBones[0]?.sourceBoneId
  const preview = resolveViewer3DMotionRetargetPreviewClip(state)
  return {
    summary: state.summary,
    session: state.session,
    selectedSourceBoneId,
    selectedMapping: selectedSourceBoneId && state.session && Object.hasOwn(state.session.mappings, selectedSourceBoneId) ? state.session.mappings[selectedSourceBoneId] : undefined,
    warnings: dedupeViewer3DWarnings([...state.diagnosticsMessages, ...(state.session?.warnings ?? []), ...(options.warnings ?? [])]),
    saveDisabledReason: resolveViewer3DMotionRetargetSaveDisabledReason(state),
    exportDisabledReason: resolveViewer3DMotionRetargetPoseClipCompanionDisabledReason(state),
    saveState: state.saveState,
    loadState: state.loadState,
    exportState: state.exportState,
    previewState: state.previewState,
    previewDisabledReason: resolveViewer3DMotionRetargetPreviewDisabledReason(state),
    previewCurrentTimeSeconds: state.previewCurrentTimeSeconds,
    previewDurationSeconds: preview.plan?.clip.durationSeconds ?? 0,
    corrections: state.corrections,
    correctionMessage: state.correctionState.message,
    correctionDirty: state.correctionState.dirty,
    animationPlaybackAvailable: Boolean(options.animationPlaybackAvailable),
    animationPlaybackActive: Boolean(options.animationPlaybackActive),
    artifactLinks: resolveViewer3DMotionRetargetArtifactEntries(state.session, options.fallbackArtifact),
    saveMessage: state.saveMessage,
    loadMessage: state.loadMessage,
    exportMessage: state.exportMessage,
    onSelectSourceBone: callbacks.onSelectSourceBone ?? (() => undefined),
    onChangeMapping: callbacks.onChangeMapping ?? (() => undefined),
    onSelectPreview: callbacks.onSelectPreview ?? (() => undefined),
    onSaveSidecar: callbacks.onSaveSidecar ?? (() => undefined),
    onLoadSidecar: callbacks.onLoadSidecar ?? (() => undefined),
    onExportPoseClipCompanion: callbacks.onExportPoseClipCompanion ?? (() => undefined),
    onOpenArtifact: callbacks.onOpenArtifact ?? (() => undefined),
    onDownloadArtifact: callbacks.onDownloadArtifact ?? (() => undefined),
    onPlayPreview: callbacks.onPlayPreview ?? (() => undefined),
    onPausePreview: callbacks.onPausePreview ?? (() => undefined),
    onResetPreview: callbacks.onResetPreview ?? (() => undefined),
    onScrubPreview: callbacks.onScrubPreview ?? (() => undefined),
    onChangeCorrections: callbacks.onChangeCorrections ?? (() => undefined),
    onToggleAnimationPlayback: callbacks.onToggleAnimationPlayback ?? (() => undefined),
  }
}

type Viewer3DKimodoMetadataDescriptor = {
  artifact: ArtifactRef
  artifactWorkspacePath: string
  bundleWorkspacePath: string
  metadataWorkspacePath: string
  metadataUrl: string
  detectionMode: 'provenance' | 'sibling-metadata'
}

export function isViewer3DKimodoSiblingMetadataCandidate(workspacePath: string | undefined): boolean {
  if (!workspacePath) return false
  const normalized = workspacePath.replace(/\\/g, '/').trim()
  if (!isSafeViewerWorkspaceRelativePath(normalized, { meshOnly: true })) return false

  const lower = normalized.toLowerCase()
  const fileName = lower.split('/').pop()
  if (fileName !== 'animated.glb' && fileName !== 'preview.glb') return false

  return lower.split('/').some((segment) => segment.includes('kimodo'))
}

export function resolveViewer3DKimodoMetadataDescriptor(args: {
  apiUrl: string
  artifact?: ArtifactRef
  modelUrl?: string | null
  workspaceDir?: string
}): Viewer3DKimodoMetadataDescriptor | undefined {
  const artifact = args.artifact ?? createViewer3DKimodoFallbackArtifactFromModelUrl(args.modelUrl, args.apiUrl, args.workspaceDir)
  if (!artifact) return undefined

  const artifactWorkspacePath = resolveViewer3DArtifactWorkspacePath(artifact, args.modelUrl, args.apiUrl, args.workspaceDir)
  if (!artifactWorkspacePath) return undefined

  const detectionMode = artifact.provenance?.extensionId === 'kimodo-soma-rp' && artifact.provenance.extensionNodeId === 'animate-rigged-mesh'
    ? 'provenance'
    : !artifact.provenance && isViewer3DKimodoSiblingMetadataCandidate(artifactWorkspacePath)
      ? 'sibling-metadata'
      : undefined
  if (!detectionMode) return undefined

  const bundleSegments = artifactWorkspacePath.split('/')
  if (bundleSegments.length < 2) return undefined
  const bundleWorkspacePath = bundleSegments.slice(0, -1).join('/')
  const metadataWorkspacePath = `${bundleWorkspacePath}/metadata.json`
  const metadataUrl = resolveViewer3DWorkspaceUrl(args.apiUrl, metadataWorkspacePath)
  if (!metadataUrl) return undefined

  return {
    artifact,
    artifactWorkspacePath,
    bundleWorkspacePath,
    metadataWorkspacePath,
    metadataUrl,
    detectionMode,
  }
}

function resolveViewer3DArtifactWorkspacePath(artifact: ArtifactRef, modelUrl?: string | null, apiUrl?: string, workspaceDir?: string): string | undefined {
  const path = resolveViewerArtifactWorkspacePath(artifact, { apiUrl, workspaceDir })
  if (!path) return undefined
  return !modelUrl || resolveViewerAssetWorkspacePathFromUrl(modelUrl, { apiUrl, workspaceDir }) === path ? path : undefined
}

function createViewer3DKimodoFallbackArtifactFromModelUrl(modelUrl: string | null | undefined, apiUrl?: string, workspaceDir?: string): ArtifactRef | undefined {
  const artifactWorkspacePath = resolveViewer3DWorkspaceMeshPathFromUrl(modelUrl, apiUrl, workspaceDir)
  if (!artifactWorkspacePath) return undefined
  const uri = `/workspace/${artifactWorkspacePath}`
  const id = `viewer3d:model-url:${artifactWorkspacePath}`
  return { id, kind: 'mesh', uri, versionId: id, legacy: { filePath: uri, outputType: 'mesh' } }
}

export function hydrateViewer3DMotionRetargetSessionFromKimodoMetadata(args: {
  descriptor?: Viewer3DKimodoMetadataDescriptor
  metadata: Record<string, unknown>
  summary?: RigSkeletonSummary
  previousSession?: MotionRetargetSession
  selectedPreview?: MotionRetargetPreviewKind
  renamePlan?: RigRenamePlan
  rigMetaNamingByBoneId?: RigMetaNamingMap
}): {
  session?: MotionRetargetSession
  diagnosticsMessages: string[]
} {
  if (!args.descriptor) return { session: undefined, diagnosticsMessages: [] }

  const sourceMeshWorkspacePath = normalizeViewer3DWorkspacePath(
    typeof args.metadata.source_workspace_path === 'string'
      ? args.metadata.source_workspace_path
      : typeof args.metadata.source_rigged_mesh === 'string'
        ? args.metadata.source_rigged_mesh
        : undefined,
  )
  const normalized = normalizeKimodoMotionArtifact({
    artifact: { ...args.descriptor.artifact, uri: `/workspace/${args.descriptor.artifactWorkspacePath}`,
      legacy: args.descriptor.artifact.legacy ? { ...args.descriptor.artifact.legacy, filePath: `/workspace/${args.descriptor.artifactWorkspacePath}` } : undefined },
    bundleWorkspacePath: args.descriptor.bundleWorkspacePath,
    metadataWorkspacePath: args.descriptor.metadataWorkspacePath,
    metadata: args.metadata,
    sourceMeshWorkspacePath,
  })

  if (!normalized.ok) {
    return {
      session: undefined,
      diagnosticsMessages: args.descriptor.detectionMode === 'sibling-metadata' ? [] : [...normalized.errors],
    }
  }

  const sourceBones = args.summary?.hasRig
    ? (normalized.artifact.motionRetarget?.status === 'parsed'
        ? normalized.artifact.motionRetarget.sourceBones.map((sourceBone) => ({
            sourceBoneId: sourceBone.sourceBoneId,
            label: sourceBone.label,
            rawLabel: sourceBone.rawLabel,
            role: sourceBone.role,
            path: sourceBone.parentSourceBoneId ? [sourceBone.parentSourceBoneId, sourceBone.label] : [sourceBone.label],
            ...(sourceBone.parentSourceBoneId ? { parentSourceBoneId: sourceBone.parentSourceBoneId } : {}),
          }))
        : deriveKimodoSourceBones(args.metadata))
    : []
  const diagnosticsMessages = dedupeViewer3DWarnings([
    ...(normalized.artifact.motionRetarget ? [] : ['Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.']),
    ...(sourceBones.length === 0 ? ['Diagnostics-only inspection is available until Kimodo exports source bone metadata.'] : []),
    ...(!isKimodoAnimatedGlbPreferred(normalized.artifact) && normalized.artifact.previewGlbWorkspacePath && normalized.artifact.animatedGlbWorkspacePath
      ? ['Kimodo reported degraded retarget diagnostics; preview GLB is preferred by default.']
      : []),
  ])

  if (!args.summary?.hasRig) {
    return { session: undefined, diagnosticsMessages }
  }

  return {
    session: createMotionRetargetSession({
      artifact: normalized.artifact,
      targetSummary: args.summary,
      sourceBones,
      snapshot: {
        mappings: args.previousSession?.mappings,
        selectedPreview: args.selectedPreview ?? args.previousSession?.selectedPreview
          ?? (isKimodoAnimatedGlbPreferred(normalized.artifact) ? 'animated-glb' : 'preview-glb'),
      },
      renamePlan: args.renamePlan,
      rigMetaNamingByBoneId: args.rigMetaNamingByBoneId,
    }),
    diagnosticsMessages,
  }
}

export function resolveViewer3DMotionRetargetModelPresentation(args: {
  defaultModelUrl: string | null
  apiUrl: string
  session?: MotionRetargetSession
  diagnosticsMessages?: readonly string[]
  explicitPreview?: MotionRetargetPreviewKind
}): {
  modelUrl: string | null
  warnings: string[]
} {
  const warnings = dedupeViewer3DWarnings([...(args.diagnosticsMessages ?? []), ...(args.session?.warnings ?? [])])
  if (!args.session) {
    return { modelUrl: args.defaultModelUrl, warnings }
  }

  const previewUrl = resolveViewer3DWorkspaceUrl(args.apiUrl, args.session.artifact.previewGlbWorkspacePath)
  if (args.explicitPreview) {
    const selectedUrl = resolveViewer3DWorkspaceUrl(args.apiUrl, args.explicitPreview === 'animated-glb'
      ? args.session.artifact.animatedGlbWorkspacePath : args.session.artifact.previewGlbWorkspacePath)
    if (selectedUrl) return { modelUrl: selectedUrl, warnings }
  }
  const animatedUrl = isKimodoAnimatedGlbPreferred(args.session.artifact)
    ? resolveViewer3DWorkspaceUrl(args.apiUrl, args.session.artifact.animatedGlbWorkspacePath)
    : undefined

  if (args.session.selectedPreview === 'animated-glb' && animatedUrl) {
    return { modelUrl: animatedUrl, warnings }
  }
  if (previewUrl) {
    return { modelUrl: previewUrl, warnings }
  }
  if (animatedUrl) {
    return { modelUrl: animatedUrl, warnings }
  }
  return { modelUrl: args.defaultModelUrl, warnings }
}

const VIEWER3D_KIMODO_SOURCE_RIG_FALLBACK_WARNING = 'Kimodo source-rig authoring fallback active because preview output is degraded and no safe animated rig output was available.'

function readViewer3DMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : undefined
}

function resolveViewer3DBundleArtifactWorkspacePath(bundleWorkspacePath: string, value: unknown, fallbackName?: string): string | undefined {
  const artifactName = typeof value === 'string' && value.trim() ? value.trim() : fallbackName
  if (!artifactName) return undefined
  const normalized = normalizeViewer3DWorkspacePath(artifactName)
  if (!normalized || /[%?#]/.test(normalized)) return undefined
  const workspacePath = normalized.includes('/') ? normalized : `${bundleWorkspacePath}/${normalized}`
  const safePath = normalizeViewer3DWorkspacePath(workspacePath)
  return safePath?.startsWith(`${bundleWorkspacePath}/`) ? safePath : undefined
}

function resolveViewer3DKimodoFallbackSourceWorkspacePath(metadata: Record<string, unknown>, workspaceDir?: string): string | undefined {
  const paths: Array<string | undefined> = []
  if (Object.hasOwn(metadata, 'source_workspace_path')) paths.push(normalizeViewer3DWorkspacePath(readViewer3DMetadataString(metadata, 'source_workspace_path')))
  if (Object.hasOwn(metadata, 'source_rigged_mesh')) paths.push(normalizeServeFileWorkspaceMeshPathFromAbsolutePath(readViewer3DMetadataString(metadata, 'source_rigged_mesh') ?? '', workspaceDir))
  const source = paths[0]
  const motion = metadata.kimodo_motion_retarget
  const contract = motion && typeof motion === 'object' && !Array.isArray(motion) ? (motion as Record<string, unknown>).source_contract : undefined
  if (contract && typeof contract === 'object' && !Array.isArray(contract)) {
    for (const key of ['source_mesh_workspace_path', 'sourceMeshWorkspacePath']) {
      if (Object.hasOwn(contract, key)) paths.push(normalizeViewer3DWorkspacePath(readViewer3DMetadataString(contract as Record<string, unknown>, key)))
    }
  }
  return source && !/[%?#]/.test(source) && isSafeRigSourceWorkspacePath(source) && paths.every(path => path === source) ? source : undefined
}

function isViewer3DKimodoPreviewOnlyDegradedArtifact(artifact: KimodoMotionArtifact, previewHasUsableRig: boolean): boolean {
  if (previewHasUsableRig) return false
  if (!artifact.previewGlbWorkspacePath) return false
  if (isKimodoAnimatedGlbPreferred(artifact)) return false

  const statuses = [
    artifact.diagnostics.runtimeStatus,
    artifact.diagnostics.retargetStatus,
    artifact.diagnostics.animationMappingStatus,
    artifact.diagnostics.visualQualityStatus,
  ].map((status) => status?.toLowerCase()).filter(Boolean)

  return statuses.some((status) => status === 'failed' || status === 'error' || status === 'preview-only' || status === 'degraded')
}

function createViewer3DKimodoFallbackArtifact(args: {
  descriptor: Viewer3DKimodoMetadataDescriptor
  metadata: Record<string, unknown>
  sourceWorkspacePath?: string
}): KimodoMotionArtifact {
  const runtimeStatus = readViewer3DMetadataString(args.metadata, 'runtime_status') ?? readViewer3DMetadataString(args.metadata, 'runtimeStatus')
  const retargetStatus = readViewer3DMetadataString(args.metadata, 'retarget_status') ?? readViewer3DMetadataString(args.metadata, 'retargetStatus')
  const solverStatus = readViewer3DMetadataString(args.metadata, 'solver_status') ?? readViewer3DMetadataString(args.metadata, 'solverStatus')
  const basisStatus = readViewer3DMetadataString(args.metadata, 'basis_status') ?? readViewer3DMetadataString(args.metadata, 'basisStatus')
  const rootMotionStatus = readViewer3DMetadataString(args.metadata, 'root_motion_status') ?? readViewer3DMetadataString(args.metadata, 'rootMotionStatus')
  const animationMappingStatus = readViewer3DMetadataString(args.metadata, 'animation_mapping_status') ?? readViewer3DMetadataString(args.metadata, 'animationMappingStatus')
  const visualQualityStatus = readViewer3DMetadataString(args.metadata, 'visual_quality_status') ?? readViewer3DMetadataString(args.metadata, 'visualQualityStatus')
  const warningsValue = args.metadata.warnings
  const warnings = Array.isArray(warningsValue) ? warningsValue.filter((warning): warning is string => typeof warning === 'string') : []
  const rawMetadata = structuredClone(args.metadata)
  delete rawMetadata.pose_clip_sidecar_workspace_path
  delete rawMetadata.poseClipSidecarWorkspacePath

  return {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    workflowId: args.descriptor.artifact.provenance?.workflowId,
    workflowNodeId: args.descriptor.artifact.provenance?.workflowNodeId,
    sourceMeshWorkspacePath: args.sourceWorkspacePath,
    previewGlbWorkspacePath: resolveViewer3DBundleArtifactWorkspacePath(args.descriptor.bundleWorkspacePath, args.metadata.preview_artifact, 'preview.glb'),
    animatedGlbWorkspacePath: resolveViewer3DBundleArtifactWorkspacePath(args.descriptor.bundleWorkspacePath, args.metadata.animated_artifact),
    bundleWorkspacePath: args.descriptor.bundleWorkspacePath,
    metadataWorkspacePath: args.descriptor.metadataWorkspacePath,
    canonicalMotionArtifactWorkspacePath: resolveViewer3DBundleArtifactWorkspacePath(args.descriptor.bundleWorkspacePath, args.metadata.canonical_motion_artifact),
    motionNpzWorkspacePath: resolveViewer3DBundleArtifactWorkspacePath(args.descriptor.bundleWorkspacePath, args.metadata.motion_npz_artifact ?? args.metadata.canonical_motion_artifact, 'motion.npz'),
    motionBvhWorkspacePath: resolveViewer3DBundleArtifactWorkspacePath(args.descriptor.bundleWorkspacePath, args.metadata.motion_bvh_artifact, 'motion.bvh'),
    diagnostics: {
      runtimeStatus: runtimeStatus ?? null,
      retargetStatus: retargetStatus ?? null,
      solverStatus: solverStatus ?? null,
      basisStatus: basisStatus ?? null,
      rootMotionStatus: rootMotionStatus ?? null,
      animationMappingStatus: animationMappingStatus ?? null,
      stabilizationStatus: readViewer3DMetadataString(args.metadata, 'stabilization_status') ?? null,
      visualQualityStatus: visualQualityStatus ?? null,
      sourceKind: readViewer3DMetadataString(args.metadata, 'source_kind') ?? null,
      mappingConfidence: readViewer3DMetadataString(args.metadata, 'mapping_confidence') ?? null,
      retargetErrorCode: readViewer3DMetadataString(args.metadata, 'retarget_error_code') ?? null,
      retargetErrorAliases: [],
      retargetErrorMessage: readViewer3DMetadataString(args.metadata, 'retarget_error_message') ?? null,
      warnings,
      raw: rawMetadata,
    },
  }
}

export function resolveViewer3DKimodoSourceRigFallback(args: {
  apiUrl: string
  defaultModelUrl: string | null
  descriptor?: Viewer3DKimodoMetadataDescriptor
  metadata?: Record<string, unknown> | null
  previewHasUsableRig: boolean
  workspaceDir?: string
}): Viewer3DKimodoSourceRigFallbackResult {
  const inactive = (artifact?: KimodoMotionArtifact, warnings: string[] = []): Viewer3DKimodoSourceRigFallbackResult => ({
    active: false,
    modelUrl: args.defaultModelUrl,
    warnings,
    ...(artifact ? { artifact } : {}),
  })

  if (!args.descriptor || !args.metadata) return inactive()
  // Bundle identity permits diagnostic inspection, never solver/rig trust. A
  // failed status in an arbitrary sibling JSON cannot choose another mesh.
  if ((Object.hasOwn(args.metadata, 'extension_id') && args.metadata.extension_id !== 'kimodo-soma-rp')
    || (Object.hasOwn(args.metadata, 'node_id') && args.metadata.node_id !== 'animate-rigged-mesh')) return inactive()
  if (args.descriptor.detectionMode !== 'provenance'
    && (args.metadata.extension_id !== 'kimodo-soma-rp' || args.metadata.node_id !== 'animate-rigged-mesh')) return inactive()
  const displayed = resolveViewer3DWorkspaceMeshPathFromUrl(args.defaultModelUrl, args.apiUrl, args.workspaceDir)
  const preview = resolveViewer3DBundleArtifactWorkspacePath(args.descriptor.bundleWorkspacePath, args.metadata.preview_artifact)
  if (!preview || displayed !== preview || args.descriptor.artifactWorkspacePath !== preview) return inactive()

  const sourceWorkspacePath = resolveViewer3DKimodoFallbackSourceWorkspacePath(args.metadata, args.workspaceDir)
  const artifact = createViewer3DKimodoFallbackArtifact({ descriptor: args.descriptor, metadata: args.metadata, sourceWorkspacePath })
  const fallbackWarnings = dedupeViewer3DWarnings([VIEWER3D_KIMODO_SOURCE_RIG_FALLBACK_WARNING, ...artifact.diagnostics.warnings])
  // Match the adapter's bundle-list path aliases and animated-output roles.
  // These are negative identity evidence, not a successful retarget contract:
  // even an incorrectly typed motion output cannot become its own source rig.
  const listedOutputs = [args.metadata.artifacts, args.metadata.bundle_artifacts]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .flatMap((entry: unknown) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : undefined
      const path = typeof entry === 'string' ? entry
        : [record?.path, record?.workspace_path, record?.workspacePath, record?.file_path, record?.filePath, record?.artifact]
          .find((value): value is string => typeof value === 'string')
      if (!path) return []
      const animated = [record?.role, record?.kind, record?.type, record?.output]
        .some((value) => typeof value === 'string' && /animated/.test(value.toLowerCase()))
        || path.replace(/\\/g, '/').split('/').at(-1) === 'animated.glb'
      return animated ? [path] : []
    })
  const diagnostics = args.metadata.diagnostics
  const generatedPaths = [
    artifact.previewGlbWorkspacePath, artifact.animatedGlbWorkspacePath,
    artifact.canonicalMotionArtifactWorkspacePath, artifact.motionNpzWorkspacePath, artifact.motionBvhWorkspacePath,
    args.metadata.preview_artifact, args.metadata.animated_artifact, args.metadata.canonical_motion_artifact,
    args.metadata.motion_npz_artifact, args.metadata.motion_bvh_artifact,
    diagnostics && typeof diagnostics === 'object' ? (diagnostics as Record<string, unknown>).bvh_path : undefined,
    ...listedOutputs,
  ]
  const bundleWorkspacePath = args.descriptor.bundleWorkspacePath
  const sourceIsGenerated = sourceWorkspacePath && generatedPaths.some((value) => typeof value === 'string'
    && (sourceWorkspacePath === resolveViewer3DBundleArtifactWorkspacePath(bundleWorkspacePath, value)
      || sourceWorkspacePath === normalizeViewer3DWorkspacePath(value)))

  if (!isViewer3DKimodoPreviewOnlyDegradedArtifact(artifact, args.previewHasUsableRig) || !sourceWorkspacePath
    || sourceIsGenerated) {
    return inactive(artifact)
  }

  const sourceUrl = resolveViewer3DWorkspaceUrl(args.apiUrl, sourceWorkspacePath)
  if (!sourceUrl) return inactive(artifact)
  const hasUntrustedTrustMetadata = ['manual_confirmed', 'trusted_contract', 'basis', 'axis', 'plane', 'kimodo_motion_retarget']
    .some((key) => Object.prototype.hasOwnProperty.call(args.metadata ?? {}, key))

  return {
    active: true,
    modelUrl: sourceUrl,
    sourceWorkspacePath,
    warnings: fallbackWarnings,
    artifact,
    ...(hasUntrustedTrustMetadata ? { trust: {
      trustedContractPresent: false,
      trustedEvidence: { sourceContract: false, basis: false, axis: false, plane: false, motion: false },
    } } : {}),
  }
}

export function resolveViewer3DAuthoringPresentation(args: {
  baseModelUrl: string | null
  currentJobId?: string
  rigSourceWorkspacePath?: string
  motionRetargetPresentation: { modelUrl: string | null, warnings: readonly string[] }
  sourceRigFallback?: Pick<Viewer3DKimodoSourceRigFallbackResult, 'active' | 'modelUrl' | 'sourceWorkspacePath' | 'warnings'>
}): Viewer3DAuthoringPresentation {
  const fallbackActive = Boolean(args.sourceRigFallback?.active && args.sourceRigFallback.modelUrl && args.sourceRigFallback.sourceWorkspacePath)
  return {
    modelUrl: fallbackActive ? args.sourceRigFallback!.modelUrl : args.motionRetargetPresentation.modelUrl,
    rigSourceWorkspacePath: fallbackActive ? args.sourceRigFallback!.sourceWorkspacePath : args.rigSourceWorkspacePath,
    resetKey: { currentJobId: args.currentJobId, baseModelUrl: args.baseModelUrl },
    warnings: dedupeViewer3DWarnings([...args.motionRetargetPresentation.warnings, ...(fallbackActive ? args.sourceRigFallback!.warnings : [])]),
  }
}

function isKimodoAnimatedGlbPreferred(artifact: KimodoMotionArtifact): boolean {
  if (!artifact.animatedGlbWorkspacePath) return false
  const failedStatuses = new Set(['failed', 'error'])
  return !failedStatuses.has((artifact.diagnostics.runtimeStatus ?? '').toLowerCase())
    && !failedStatuses.has((artifact.diagnostics.retargetStatus ?? '').toLowerCase())
    && !failedStatuses.has((artifact.diagnostics.animationMappingStatus ?? '').toLowerCase())
}

function resolveViewer3DWorkspaceUrl(apiUrl: string, workspacePath: string | undefined): string | undefined {
  const normalized = normalizeViewer3DWorkspacePath(workspacePath)
  return normalized ? `${apiUrl}/workspace/${normalized}` : undefined
}

export function createViewer3DArtifactPreviewState(): Viewer3DArtifactPreviewState {
  return { status: 'closed' }
}

function applyViewer3DMotionRetargetArtifactPreviewResult(
  artifact: Viewer3DMotionRetargetArtifactEntry,
  result: WorkspaceArtifactPreviewResult,
): Viewer3DArtifactPreviewState {
  if (!result.success) {
    return {
      status: 'binary',
      title: artifact.label,
      workspacePath: artifact.workspacePath,
      displayName: artifact.downloadName ?? artifact.label,
      byteLength: 0,
      binaryKind: 'error',
      message: result.error,
    }
  }

  if (result.status === 'text') {
    return {
      status: 'text',
      title: artifact.label,
      workspacePath: result.workspacePath,
      displayName: result.displayName,
      content: result.content,
      byteLength: result.byteLength,
      truncated: result.truncated,
    }
  }

  if (result.status === 'binary') {
    return {
      status: 'binary',
      title: artifact.label,
      workspacePath: result.workspacePath,
      displayName: result.displayName,
      byteLength: result.byteLength,
      binaryKind: result.binaryKind,
      message: result.message,
    }
  }

  if (result.status === 'audio') {
    return {
      status: 'audio',
      title: artifact.label,
      workspacePath: result.workspacePath,
      displayName: result.displayName,
      byteLength: result.byteLength,
      audioKind: result.audioKind,
      sourceUrl: result.sourceUrl,
    }
  }

  return createViewer3DArtifactPreviewState()
}

export async function openViewer3DMotionRetargetArtifact({
  state,
  artifact,
  previewReader,
}: {
  state: Viewer3DMotionRetargetState
  artifact: Viewer3DMotionRetargetArtifactEntry
  previewReader: (request: WorkspaceArtifactPreviewRequest) => Promise<WorkspaceArtifactPreviewResult>
}): Promise<{ motionRetargetState: Viewer3DMotionRetargetState, previewState: Viewer3DArtifactPreviewState }> {
  if (artifact.openMode === 'viewer3d-preview') {
    const selectedPreview = artifact.key === 'animated-glb' ? 'animated-glb' : 'preview-glb'
    return {
      motionRetargetState: reduceViewer3DMotionRetargetState(state, { type: 'set-preview', selectedPreview }),
      previewState: createViewer3DArtifactPreviewState(),
    }
  }

  const result = await previewReader({ workspacePath: artifact.workspacePath })
  return {
    motionRetargetState: state,
    previewState: applyViewer3DMotionRetargetArtifactPreviewResult(artifact, result),
  }
}

export async function downloadViewer3DMotionRetargetArtifact({
  artifact,
  downloader,
}: {
  artifact: Viewer3DMotionRetargetArtifactEntry
  downloader: (request: WorkspaceArtifactDownloadRequest) => Promise<WorkspaceArtifactDownloadResult>
}): Promise<WorkspaceArtifactDownloadResult> {
  return downloader({
    workspacePath: artifact.workspacePath,
    suggestedName: artifact.downloadName,
  })
}

export function resolveViewer3DMotionRetargetArtifactEntries(session?: MotionRetargetSession, fallbackArtifact?: KimodoMotionArtifact): Viewer3DMotionRetargetArtifactEntry[] {
  const sourceArtifact = session?.artifact ?? fallbackArtifact
  if (!sourceArtifact) return []

  const artifacts = [
    { key: 'metadata', label: 'Metadata JSON', workspacePath: sourceArtifact.metadataWorkspacePath, openMode: 'workspace-preview' as const },
    { key: 'animated-glb', label: 'Animated GLB', workspacePath: sourceArtifact.animatedGlbWorkspacePath, openMode: 'viewer3d-preview' as const },
    { key: 'preview-glb', label: 'Preview GLB', workspacePath: sourceArtifact.previewGlbWorkspacePath, openMode: 'viewer3d-preview' as const },
    { key: 'motion-npz', label: 'Motion NPZ', workspacePath: sourceArtifact.motionNpzWorkspacePath, openMode: 'workspace-preview' as const },
    { key: 'motion-bvh', label: 'Motion BVH', workspacePath: sourceArtifact.motionBvhWorkspacePath, openMode: 'workspace-preview' as const },
  ]

  return artifacts.flatMap((artifact) => {
    if (!artifact.workspacePath || !normalizeViewer3DWorkspacePath(artifact.workspacePath)) return []
    return [{
      key: artifact.key,
      label: artifact.label,
      workspacePath: artifact.workspacePath,
      downloadName: artifact.workspacePath.split('/').filter(Boolean).at(-1) ?? `${artifact.key}.artifact`,
      openMode: artifact.openMode,
    } satisfies Viewer3DMotionRetargetArtifactEntry]
  })
}

function normalizeViewer3DWorkspacePath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.replace(/^\/workspace\//, '')
  const normalized = normalizeSceneWorkspacePath(path)
  return normalized === path ? normalized : undefined
}

function createViewer3DDisplayedSemanticHydrationSource(
  displayedMeshWorkspacePath: string | undefined,
  warnings: string[] = [],
  failedClosed = false,
): Viewer3DSemanticHydrationSource | undefined {
  if (!displayedMeshWorkspacePath) return undefined
  return {
    displayedMeshWorkspacePath,
    semanticSourceWorkspacePath: displayedMeshWorkspacePath,
    sourceKind: 'displayed-mesh',
    warnings,
    failedClosed,
  }
}

function normalizeViewer3DSemanticWorkspaceSourcePath(value: unknown): string | undefined {
  const normalized = normalizeViewer3DWorkspacePath(typeof value === 'string' ? value : undefined)
  return normalized && isSafeViewerWorkspaceRelativePath(normalized, { meshOnly: true }) ? normalized : undefined
}

function normalizeViewer3DSemanticSourceFromAbsolutePath(value: unknown, workspaceDir?: string): string | undefined {
  if (typeof value !== 'string') return undefined
  return normalizeServeFileWorkspaceMeshPathFromAbsolutePath(value, workspaceDir)
}

export function resolveViewer3DSemanticHydrationSource(args: {
  displayedMeshWorkspacePath?: string
  descriptor?: Viewer3DKimodoMetadataDescriptor
  metadata?: Record<string, unknown> | null
  workspaceDir?: string
}): Viewer3DSemanticHydrationSource | undefined {
  const fallback = createViewer3DDisplayedSemanticHydrationSource(args.displayedMeshWorkspacePath)
  if (!fallback) return undefined
  if (!args.descriptor || !args.metadata) return fallback

  const displayedFilename = fallback.displayedMeshWorkspacePath.split('/').filter(Boolean).at(-1)?.toLowerCase()
  if (displayedFilename !== 'animated.glb') return fallback

  const semanticSourceWorkspacePath = normalizeViewer3DSemanticWorkspaceSourcePath(args.metadata.source_workspace_path)
    ?? normalizeViewer3DSemanticSourceFromAbsolutePath(args.metadata.source_rigged_mesh, args.workspaceDir)

  if (!semanticSourceWorkspacePath) {
    return createViewer3DDisplayedSemanticHydrationSource(
      fallback.displayedMeshWorkspacePath,
      ['Kimodo semantic source metadata was missing or unsafe, so display-only inheritance stayed on the displayed mesh.'],
      true,
    )
  }

  if (semanticSourceWorkspacePath === fallback.displayedMeshWorkspacePath) return fallback

  return {
    displayedMeshWorkspacePath: fallback.displayedMeshWorkspacePath,
    semanticSourceWorkspacePath,
    sourceKind: 'kimodo-source',
    warnings: [],
    failedClosed: false,
  }
}

function dedupeViewer3DWarnings(warnings: readonly string[]): string[] {
  return Array.from(new Set(warnings.filter((warning) => typeof warning === 'string' && warning.trim().length > 0)))
}

function isHumanoidDraftFound(result: HumanoidDraftSidecarReadResult | undefined): result is Extract<HumanoidDraftSidecarReadResult, { success: true, status: 'found' | 'stale' }> {
  return Boolean(result?.success && (result.status === 'found' || result.status === 'stale'))
}

function isHumanoidPromotionFound(result: HumanoidPromotionSidecarReadResult | undefined): result is Extract<HumanoidPromotionSidecarReadResult, { success: true, status: 'found' | 'stale' }> {
  return Boolean(result?.success && (result.status === 'found' || result.status === 'stale'))
}

function collectHumanoidDiagnostics(
  draftResult: HumanoidDraftSidecarReadResult | undefined,
  promotionResult: HumanoidPromotionSidecarReadResult | undefined,
): string[] {
  const diagnostics: string[] = []

  if (draftResult?.success === false) diagnostics.push(draftResult.error)
  if (promotionResult?.success === false) diagnostics.push(promotionResult.error)
  if (isHumanoidDraftFound(draftResult)) {
    diagnostics.push(...draftResult.sidecar.diagnostics)
    if (draftResult.status === 'stale') diagnostics.push(...draftResult.staleReasons)
  }
  if (isHumanoidPromotionFound(promotionResult) && promotionResult.status === 'stale') {
    diagnostics.push(...promotionResult.staleReasons)
  }

  return dedupeViewer3DWarnings(diagnostics)
}

export function createViewer3DHumanoidProposedAssignments(
  draft?: Pick<HumanoidDraftSidecarV1, 'assignments'>,
): Viewer3DHumanoidProposedAssignments {
  if (!draft) return structuredClone(EMPTY_HUMANOID_ASSIGNMENTS)
  return {
    roles: structuredClone(draft.assignments.roles ?? {}),
    chains: structuredClone(draft.assignments.chains ?? {}),
  }
}

export function applyViewer3DHumanoidRoleProposalChange(
  assignments: Viewer3DHumanoidProposedAssignments,
  roleKey: string,
  nextValue: unknown,
): Viewer3DHumanoidProposedAssignments {
  return {
    roles: { ...structuredClone(assignments.roles), [roleKey]: structuredClone(nextValue) },
    chains: structuredClone(assignments.chains),
  }
}

export function applyViewer3DHumanoidChainProposalChange(
  assignments: Viewer3DHumanoidProposedAssignments,
  chainKey: string,
  nextValue: unknown,
): Viewer3DHumanoidProposedAssignments {
  return {
    roles: structuredClone(assignments.roles),
    chains: { ...structuredClone(assignments.chains), [chainKey]: structuredClone(nextValue) },
  }
}

export function resolveViewer3DHumanoidReviewPresentation({
  trustedContractPresent,
  draftResult,
  promotionResult,
}: {
  trustedContractPresent: boolean
  draftResult?: HumanoidDraftSidecarReadResult
  promotionResult?: HumanoidPromotionSidecarReadResult
}): Viewer3DHumanoidReviewPresentation {
  const diagnostics = collectHumanoidDiagnostics(draftResult, promotionResult)

  if (trustedContractPresent) {
    return {
      state: 'trusted',
      headline: 'Trusted UniRig humanoid contract is already present.',
      canPromote: false,
      diagnostics,
    }
  }

  if (isHumanoidPromotionFound(promotionResult) && promotionResult.status === 'found'
    && isHumanoidDraftFound(draftResult) && draftResult.status === 'found') {
    return {
      state: 'promoted',
      headline: 'Manual promotion is active for this mesh.',
      canPromote: Boolean(isHumanoidDraftFound(draftResult) && draftResult.status === 'found'),
      diagnostics,
    }
  }

  if (
    (isHumanoidPromotionFound(promotionResult) && promotionResult.status === 'stale')
    || (isHumanoidDraftFound(draftResult) && draftResult.status === 'stale')
  ) {
    return {
      state: 'stale',
      headline: 'Humanoid draft or promotion is stale and blocked.',
      canPromote: false,
      diagnostics,
    }
  }

  if (isHumanoidDraftFound(draftResult) && draftResult.status === 'found') {
    return {
      state: 'draft',
      headline: 'Draft humanoid proposal available for manual review.',
      canPromote: true,
      diagnostics,
    }
  }

  return {
    state: 'diagnostics-only',
    headline: 'No promotable humanoid draft is available for this mesh.',
    canPromote: false,
    diagnostics,
  }
}

export function resolveViewer3DHumanoidPromotionGate({
  presentation,
  rationale,
  confirmationChecked,
  writerAvailable,
}: {
  presentation: Viewer3DHumanoidReviewPresentation
  rationale: string
  confirmationChecked: boolean
  writerAvailable: boolean
}): { allowed: true } | { allowed: false, reason: string } {
  if (!presentation.canPromote) {
    return {
      allowed: false,
      reason: presentation.state === 'stale'
        ? 'Promotion is blocked until the stale humanoid artifacts are regenerated.'
        : 'No valid humanoid draft is available for promotion.',
    }
  }
  if (!confirmationChecked) {
    return { allowed: false, reason: 'Explicit confirmation is required before manual promotion.' }
  }
  if (!rationale.trim()) {
    return { allowed: false, reason: 'Promotion rationale is required for auditability.' }
  }
  if (!writerAvailable) {
    return { allowed: false, reason: 'Workspace humanoid promotion writer is unavailable.' }
  }
  return { allowed: true }
}

export function buildViewer3DHumanoidPromotionWriteRequest({
  meshWorkspacePath,
  draft,
  sourceSha256,
  existingPromotion,
  proposedAssignments,
  rationale,
  createdAt,
  confirmedBy,
  confirmedByLabel,
  method,
  promotionId,
}: {
  meshWorkspacePath: string
  draft: HumanoidDraftSidecarV1
  sourceSha256?: string
  existingPromotion?: HumanoidPromotionSidecarV1
  proposedAssignments: Viewer3DHumanoidProposedAssignments
  rationale: string
  createdAt: string
  confirmedBy: string
  confirmedByLabel?: string
  method: HumanoidPromotionMethod
  promotionId: string
}): HumanoidPromotionSidecarWriteRequest {
  return {
    meshWorkspacePath,
    sidecar: {
      schema: 'modly.humanoid-promotion.v1',
      version: 1,
      promotionId,
      ...(existingPromotion?.promotionId ? { supersedesPromotionId: existingPromotion.promotionId } : {}),
      source: structuredClone(draft.source),
      output: { workspacePath: meshWorkspacePath },
      meshOutputSha256: draft.meshOutputSha256,
      rigmetaSha256: draft.rigmetaSha256,
      draftSha256: draft.draftSha256,
      ...(draft.draftContentSha256 ? { draftContentSha256: draft.draftContentSha256 } : {}),
      ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
      draftSchema: draft.schema,
      promotedAssignments: structuredClone(proposedAssignments),
      provenance: { basis: 'modly.humanoid-draft.v1', trustStatus: 'manual_confirmed' },
      audit: {
        confirmedBy,
        ...(confirmedByLabel ? { confirmedByLabel } : {}),
        createdAt,
        method,
        rationale: rationale.trim(),
      },
    },
  }
}

function createViewer3DHumanoidReviewState(meshWorkspacePath?: string): Viewer3DHumanoidReviewState {
  return {
    meshWorkspacePath,
    trustedContractPresent: false,
    proposedAssignments: structuredClone(EMPTY_HUMANOID_ASSIGNMENTS),
    isProposalDirty: false,
    rationale: DEFAULT_VIEWER3D_HUMANOID_PROMOTION_RATIONALE,
    confirmationChecked: true,
    loadState: 'idle',
    saveState: { status: 'idle' },
  }
}

export function resolveViewer3DHumanoidHydrationRequest(
  summary?: RigSkeletonSummary,
  semanticHydrationSource?: Viewer3DSemanticHydrationSource,
): {
  draft: HumanoidDraftSidecarReadRequest
  promotion: HumanoidPromotionSidecarReadRequest
  displayedMeshWorkspacePath: string
  sourceKind: Viewer3DSemanticHydrationSource['sourceKind']
} | null {
  if (!summary?.hasRig || !summary.sourceWorkspacePath) return null
  const semanticSourceWorkspacePath = semanticHydrationSource?.semanticSourceWorkspacePath ?? summary.sourceWorkspacePath
  return {
    draft: { meshWorkspacePath: semanticSourceWorkspacePath },
    promotion: { meshWorkspacePath: semanticSourceWorkspacePath },
    displayedMeshWorkspacePath: summary.sourceWorkspacePath,
    sourceKind: semanticHydrationSource?.sourceKind ?? 'displayed-mesh',
  }
}

function applyViewer3DHumanoidHydration({
  state,
  meshWorkspacePath,
  trustedContractPresent,
  draftResult,
  promotionResult,
}: {
  state: Viewer3DHumanoidReviewState
  meshWorkspacePath: string
  trustedContractPresent: boolean
  draftResult: HumanoidDraftSidecarReadResult
  promotionResult: HumanoidPromotionSidecarReadResult
}): Viewer3DHumanoidReviewState {
  const currentDraftSha256 = isHumanoidDraftFound(draftResult) ? draftResult.sidecar.draftSha256 : undefined
  const shouldResetProposal = state.meshWorkspacePath !== meshWorkspacePath || (!state.isProposalDirty && isHumanoidDraftFound(draftResult))

  return {
    ...state,
    meshWorkspacePath,
    trustedContractPresent,
    draftResult,
    promotionResult: isHumanoidDraftReadable(draftResult) ? promotionResult : undefined,
    proposedAssignments: shouldResetProposal && isHumanoidDraftFound(draftResult)
      ? createViewer3DHumanoidProposedAssignments(draftResult.sidecar)
      : shouldResetProposal
        ? structuredClone(EMPTY_HUMANOID_ASSIGNMENTS)
        : state.proposedAssignments,
    proposalSourceDraftSha256: shouldResetProposal ? currentDraftSha256 : state.proposalSourceDraftSha256,
    isProposalDirty: shouldResetProposal ? false : state.isProposalDirty,
    rationale: shouldResetProposal ? DEFAULT_VIEWER3D_HUMANOID_PROMOTION_RATIONALE : state.rationale,
    confirmationChecked: shouldResetProposal ? true : state.confirmationChecked,
    loadState: 'loaded',
    saveState: { status: 'idle' },
  }
}

export function hasTrustedHumanoidContract(rigMeta: unknown, summary: RigSkeletonSummary | undefined): boolean {
  if (!summary?.hasRig) return false
  if (!rigMeta || typeof rigMeta !== 'object') return false
  const metadata = rigMeta as Record<string, unknown>
  const contract = metadata.humanoid_contract as Record<string, unknown> | undefined
  if (!contract || typeof contract !== 'object' || !contract.required_roles || typeof contract.required_roles !== 'object') return false
  const validation = contract.validation as { status?: unknown } | undefined
  const provenance = contract.provenance as { trust_scope?: { trusted?: unknown } } | undefined
  const translation = translateHumanoidAssignmentsToRigMetaNaming({ summary,
    sources: [{ source: 'humanoid_contract', roleMap: { roles: contract.required_roles } }] })
  if (translation.diagnostics.length > 0 || Object.keys(translation.namingByBoneId).length === 0) return false
  return contract.schema === 'modly.humanoid.v1' && (contract.humanoid_contract_status ?? metadata.humanoid_contract_status) === 'trusted'
    && validation?.status === 'validated' && Array.isArray(provenance?.trust_scope?.trusted)
    && provenance.trust_scope.trusted.includes('required_roles')
}

function resolveViewer3DHumanoidPromotionMethod(args: {
  currentJobId?: string
  workflowArtifactPresent: boolean
}): HumanoidPromotionMethod {
  if (args.currentJobId?.startsWith('import-')) return 'import'
  if (args.workflowArtifactPresent) return 'add-to-scene'
  return 'viewer3d'
}

const MOTION_RETARGET_SAVE_UNAVAILABLE = 'Save is unavailable until Modly validates a trusted Kimodo motion payload with complete translated source bone metadata.'
const MOTION_RETARGET_COMPANION_METADATA_UNAVAILABLE = 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.'
const MOTION_RETARGET_PREVIEW_UNAVAILABLE = 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.'

function resolveViewer3DMotionRetargetSaveDisabledReason(state: Viewer3DMotionRetargetState): string | undefined {
  state = { ...state, session: canonicalViewer3DMotionRetargetSession(state.summary, state.session) }
  if (!state.summary?.hasRig || !state.summary.sourceWorkspacePath) return 'Save requires a source-backed rig.'
  if (!state.session) return 'Save requires a loaded Kimodo motion session.'
  if (!state.session.unlockReadiness.canSaveSidecar || !state.session.exportReadiness.canSaveSidecar) return MOTION_RETARGET_SAVE_UNAVAILABLE
  // The immutable correction source cannot also be a generated bundle artifact.
  // Match the accepted main-process source-alias boundary before advertising Save.
  for (const key of ['bundleWorkspacePath', 'metadataWorkspacePath', 'previewGlbWorkspacePath', 'animatedGlbWorkspacePath', 'canonicalMotionArtifactWorkspacePath', 'motionNpzWorkspacePath', 'motionBvhWorkspacePath'] as const) {
    if (normalizeViewer3DWorkspacePath(state.session.artifact[key]) === state.summary.sourceWorkspacePath) {
      return `Save requires a source mesh distinct from generated artifact paths (${key}).`
    }
  }
  const workspaceValidation = validateViewer3DMotionRetargetSidecarWorkspacePath(state.summary.sourceWorkspacePath, state.session, state.summary.skeletonContextId)
  if (workspaceValidation) return workspaceValidation
  return undefined
}

function resolveViewer3DMotionRetargetPoseClipCompanionDerivation(state: Viewer3DMotionRetargetState) {
  if (!state.summary?.hasRig || !state.summary.sourceWorkspacePath || !state.session) return null
  const derivation = deriveKimodoPoseClipCompanionV1({
    summary: state.summary,
    artifact: state.session.artifact,
    sourceBones: state.session.sourceBones,
    mappings: state.session.mappings,
  })
  if (!derivation.available || !derivation.sidecarWorkspacePath) return derivation
  const validation = validatePoseClipSidecarWorkspacePath({
    sidecarWorkspacePath: derivation.sidecarWorkspacePath,
    sourceWorkspacePath: state.summary.sourceWorkspacePath,
  })
  if (validation.valid) return derivation
  return {
    ...derivation,
    available: false,
    warnings: validation.warnings,
  }
}

function resolveViewer3DMotionRetargetPreviewClip(state: Viewer3DMotionRetargetState) {
  state = { ...state, session: canonicalViewer3DMotionRetargetSession(state.summary, state.session) }
  if (!state.summary?.hasRig || !state.session) return { available: false, warnings: [MOTION_RETARGET_PREVIEW_UNAVAILABLE] }
  if (!state.session.unlockReadiness.canPreview) return { available: false, warnings: [...state.session.unlockReadiness.blockingWarnings] }
  return resolveMotionRetargetPreviewClip({
    summary: state.summary,
    artifact: state.session.artifact,
    sourceBones: state.session.sourceBones,
    mappings: state.session.mappings,
  })
}

function resolveViewer3DMotionRetargetPoseClipCompanionDisabledReason(state: Viewer3DMotionRetargetState): string | undefined {
  state = { ...state, session: canonicalViewer3DMotionRetargetSession(state.summary, state.session) }
  if (!state.summary?.hasRig || !state.summary.sourceWorkspacePath) return 'Companion export requires a source-backed rig.'
  if (!state.session) return 'Companion export requires a loaded Kimodo motion session.'
  if (!state.session.unlockReadiness.canExportPoseClip || !state.session.exportReadiness.canExportPoseClip) return MOTION_RETARGET_COMPANION_METADATA_UNAVAILABLE
  const derivation = resolveViewer3DMotionRetargetPoseClipCompanionDerivation(state)
  if (!derivation?.available) {
    return derivation?.warnings[0] ?? MOTION_RETARGET_COMPANION_METADATA_UNAVAILABLE
  }
  return undefined
}

function resolveViewer3DMotionRetargetPreviewDisabledReason(state: Viewer3DMotionRetargetState): string | undefined {
  if (!state.summary?.hasRig || !state.summary.sourceWorkspacePath) return 'Local preview requires a source-backed rig.'
  if (!state.session) return 'Local preview requires a loaded Kimodo motion session.'
  const preview = resolveViewer3DMotionRetargetPreviewClip(state)
  if (preview.available) return undefined
  return preview.warnings.find((warning) => /^Local rotation preview disabled because Kimodo (?:omitted basis\/rest-pose evidence|marked the retarget basis invalid)/i.test(warning))
    ?? MOTION_RETARGET_PREVIEW_UNAVAILABLE
}

function createViewer3DMotionRetargetSidecarWorkspacePath(sourceWorkspacePath: string, session?: MotionRetargetSession, skeletonContextId?: string): string {
  const identity = session
    ? createMotionRetargetCorrectionIdentity({ sourceWorkspacePath, skeletonContextId, artifact: session.artifact })
    : undefined
  const stem = identity?.key ?? createViewer3DLegacyMotionRetargetSidecarStem(sourceWorkspacePath)
  return `Workflows/motion-retarget/${stem}.motion-retarget.v1.json`
}

function createViewer3DLegacyMotionRetargetSidecarStem(sourceWorkspacePath: string): string {
  const normalized = sourceWorkspacePath.replace(/\\/g, '/')
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? 'motion-retarget'
  const withoutExtension = filename.replace(/\.[^.]+$/, '') || 'motion-retarget'
  return withoutExtension.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'motion-retarget'
}

function validateViewer3DMotionRetargetSidecarWorkspacePath(sourceWorkspacePath: string, session?: MotionRetargetSession, skeletonContextId?: string): string | undefined {
  const sidecarWorkspacePath = createViewer3DMotionRetargetSidecarWorkspacePath(sourceWorkspacePath, session, skeletonContextId)
  if (sidecarWorkspacePath.startsWith('/') || /^[A-Za-z]:\//.test(sidecarWorkspacePath)) {
    return 'Motion retarget sidecar path must be workspace-relative.'
  }
  if (sidecarWorkspacePath.split('/').includes('..')) {
    return 'Motion retarget sidecar path cannot contain traversal segments.'
  }
  if (!sidecarWorkspacePath.startsWith('Workflows/motion-retarget/')) {
    return 'Motion retarget sidecar path must stay under Workflows/motion-retarget/.'
  }
  if (!sidecarWorkspacePath.endsWith('.motion-retarget.v1.json')) {
    return 'Motion retarget sidecar path must end with .motion-retarget.v1.json.'
  }
  if (sidecarWorkspacePath === sourceWorkspacePath) {
    return 'Motion retarget sidecar path cannot overwrite the source asset.'
  }
  return undefined
}

function canonicalViewer3DMotionRetargetSession(summary?: RigSkeletonSummary, session?: MotionRetargetSession): MotionRetargetSession | undefined {
  if (!summary || !session) return undefined
  const canonical = createMotionRetargetSession({ targetSummary: summary, artifact: session.artifact, sourceBones: session.sourceBones,
    snapshot: { selectedPreview: session.selectedPreview, mappings: session.mappings } })
  const labels = new Map(session.targetBones.map(bone => [bone.boneId, bone]))
  canonical.targetBones = canonical.targetBones.map(bone => {
    const display = labels.get(bone.boneId)
    return display ? { ...bone, label: display.label, labelProvenance: display.labelProvenance } : bone
  })
  // Rebuild from canonical identities so diagnostics use the same display labels.
  return reduceMotionRetargetSession(canonical, { type: 'hydrate', snapshot: { selectedPreview: canonical.selectedPreview, mappings: canonical.mappings } })
}

function deriveKimodoSourceBones(metadata: Record<string, unknown>): MotionRetargetSourceBone[] {
  const candidates = Array.isArray(metadata.source_bones) ? metadata.source_bones : []
  return candidates.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return []
    const sourceBone = candidate as Record<string, unknown>
    const sourceBoneId = typeof sourceBone.source_bone_id === 'string'
      ? sourceBone.source_bone_id
      : typeof sourceBone.id === 'string'
        ? sourceBone.id
        : undefined
    const label = typeof sourceBone.label === 'string'
      ? sourceBone.label
      : typeof sourceBone.name === 'string'
        ? sourceBone.name
        : sourceBoneId
    const rawLabel = typeof sourceBone.raw_label === 'string'
      ? sourceBone.raw_label
      : label
    const path = Array.isArray(sourceBone.path)
      ? sourceBone.path.flatMap((segment) => typeof segment === 'string' ? [segment] : [])
      : []
    if (!sourceBoneId || !label || !rawLabel) return []
    return [{
      sourceBoneId,
      label,
      rawLabel,
      path: path.length > 0 ? path : [label],
      ...(typeof sourceBone.role === 'string' ? { role: sourceBone.role } : {}),
      ...(typeof sourceBone.chain === 'string' ? { chain: sourceBone.chain } : {}),
      ...(typeof sourceBone.parent_source_bone_id === 'string' ? { parentSourceBoneId: sourceBone.parent_source_bone_id } : {}),
    } satisfies MotionRetargetSourceBone]
  })
}

export function resolveViewer3DMotionRetargetToolbarControls({
  modelUrl,
  summary,
  visibility,
  onOpenMotionRetarget,
}: {
  modelUrl: string | null
  summary?: RigSkeletonSummary
  visibility: Viewer3DMotionRetargetVisibilityState
  onOpenMotionRetarget: () => void
}): {
  active: boolean
  summary: RigSkeletonSummary
  onOpenMotionRetarget: () => void
} | undefined {
  void modelUrl
  void summary
  void visibility
  void onOpenMotionRetarget
  return undefined
}

type Viewer3DPoseClipCallbacks = {
  onCurrentTimeChange?: (timeSeconds: number) => void
  onClipMetadataChange?: (metadata: { durationSeconds?: number; fps?: number }) => void
  onCaptureKeyframe?: (boneId: RigBoneId, timeSeconds: number) => void
  onCaptureAndAdvance?: (boneId: RigBoneId) => void
  onSelectKeyframe?: (keyframeId: string, boneId: RigBoneId) => void
  onDeleteKeyframe?: (keyframeId: string, boneId: RigBoneId) => void
  onUpdateSelectedKeyframe?: (keyframeId: string, boneId: RigBoneId) => void
  onDeleteSelectedKeyframe?: (keyframeId: string, boneId: RigBoneId) => void
  onMoveSelectedKeyframe?: (keyframeId: string, timeSeconds: number) => void
  onShiftSelectedKeyframe?: (keyframeId: string, deltaSeconds: number) => void
  onDuplicateSelectedKeyframe?: (keyframeId: string) => void
  onPreviewPlay?: () => void
  onPreviewPause?: () => void
  onPreviewReset?: () => void
  onRotateSelectedTarget?: (boneId: RigBoneId, axis: PoseClipRotationAxis, degreesDelta: number) => void
  onResetSelectedTarget?: (boneId: RigBoneId) => void
  onSaveSidecar?: () => void
  onLoadSidecar?: () => void
  drawerMode?: PoseClipDrawerMode
  onDrawerModeChange?: (drawerMode: PoseClipDrawerMode) => void
}

export function resolveViewer3DPoseClipPanelProps(
  state: Viewer3DPoseClipState,
  callbacks: Viewer3DPoseClipCallbacks,
  effectiveNaming?: RigEffectiveNamingResult,
): {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  rigDisplayNames?: RigDisplayNamingResult
  keyframes: PoseClipPlan['keyframes']
  selectedKeyframeId?: string
  currentTimeSeconds: number
  durationSeconds: number
  fps: number
  previewState: PoseClipPreviewState
  saveState: PoseClipSaveState
  loadState: PoseClipLoadState
  warnings: PoseClipPanelWarning[]
  saveError?: string
  loadError?: string
  drawerMode?: PoseClipDrawerMode
  onDrawerModeChange?: (drawerMode: PoseClipDrawerMode) => void
  onCurrentTimeChange: (timeSeconds: number) => void
  onClipMetadataChange: (metadata: { durationSeconds?: number; fps?: number }) => void
  onCaptureKeyframe: (boneId: RigBoneId, timeSeconds: number) => void
  onCaptureAndAdvance: (boneId: RigBoneId) => void
  onSelectKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onDeleteKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onUpdateSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onDeleteSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onMoveSelectedKeyframe: (keyframeId: string, timeSeconds: number) => void
  onShiftSelectedKeyframe: (keyframeId: string, deltaSeconds: number) => void
  onDuplicateSelectedKeyframe: (keyframeId: string) => void
  onPreviewPlay: () => void
  onPreviewPause: () => void
  onPreviewReset: () => void
  onRotateSelectedTarget: (boneId: RigBoneId, axis: PoseClipRotationAxis, degreesDelta: number) => void
  onResetSelectedTarget: (boneId: RigBoneId) => void
  onSaveSidecar: () => void
  onLoadSidecar: () => void
} {
  return {
    summary: state.summary,
    selectedBoneId: state.selectedBoneId,
    rigDisplayNames: state.summary?.hasRig ? resolveRigDisplayNames({ summary: state.summary, effectiveNaming }) : undefined,
    keyframes: state.plan.keyframes,
    selectedKeyframeId: state.selectedKeyframeId,
    currentTimeSeconds: state.currentTimeSeconds,
    durationSeconds: state.plan.clip.durationSeconds,
    fps: state.plan.clip.fps,
    previewState: state.previewState,
    saveState: state.saveState,
    loadState: state.loadState,
    warnings: state.warning?.messages.map((message) => ({ kind: 'invalid-sidecar' as const, message })) ?? [],
    saveError: state.saveError,
    loadError: state.loadError,
    onCurrentTimeChange: callbacks.onCurrentTimeChange ?? (() => undefined),
    onClipMetadataChange: callbacks.onClipMetadataChange ?? (() => undefined),
    onCaptureKeyframe: callbacks.onCaptureKeyframe ?? (() => undefined),
    onCaptureAndAdvance: callbacks.onCaptureAndAdvance ?? (() => undefined),
    onSelectKeyframe: callbacks.onSelectKeyframe ?? (() => undefined),
    onDeleteKeyframe: callbacks.onDeleteKeyframe ?? (() => undefined),
    onUpdateSelectedKeyframe: callbacks.onUpdateSelectedKeyframe ?? (() => undefined),
    onDeleteSelectedKeyframe: callbacks.onDeleteSelectedKeyframe ?? (() => undefined),
    onMoveSelectedKeyframe: callbacks.onMoveSelectedKeyframe ?? (() => undefined),
    onShiftSelectedKeyframe: callbacks.onShiftSelectedKeyframe ?? (() => undefined),
    onDuplicateSelectedKeyframe: callbacks.onDuplicateSelectedKeyframe ?? (() => undefined),
    onPreviewPlay: callbacks.onPreviewPlay ?? (() => undefined),
    onPreviewPause: callbacks.onPreviewPause ?? (() => undefined),
    onPreviewReset: callbacks.onPreviewReset ?? (() => undefined),
    onRotateSelectedTarget: callbacks.onRotateSelectedTarget ?? (() => undefined),
    onResetSelectedTarget: callbacks.onResetSelectedTarget ?? (() => undefined),
    onSaveSidecar: callbacks.onSaveSidecar ?? (() => undefined),
    onLoadSidecar: callbacks.onLoadSidecar ?? (() => undefined),
  }
}

export function resolveViewer3DActiveRigTargetState({
  rigEditorState,
  rigEditorVisibility,
  poseClipState,
  poseClipVisibility,
  selectedTarget,
}: {
  rigEditorState: Viewer3DRigEditorState
  rigEditorVisibility: Viewer3DRigEditorVisibilityState
  poseClipState: Viewer3DPoseClipState
  poseClipVisibility: Viewer3DPoseClipVisibilityState
  selectedTarget?: Viewer3DSelectedRigTargetState
}): Viewer3DRigTargetState {
  const resolveSelectedBoneId = (summary: RigSkeletonSummary | undefined, fallback?: RigBoneId): RigBoneId | undefined => {
    if (!selectedTarget || summary?.skeletonContextId !== selectedTarget.skeletonContextId) return fallback
    return resolveValidRigSelectedBoneId(summary, selectedTarget.selectedBoneId)
  }
  if (rigEditorVisibility.isOpen && rigEditorState.summary?.hasRig) {
    return { summary: rigEditorState.summary, selectedBoneId: resolveSelectedBoneId(rigEditorState.summary, rigEditorState.selectedBoneId), activeMode: 'rig-editor' }
  }
  if (poseClipVisibility.isOpen && poseClipState.summary?.hasRig) {
    return { summary: poseClipState.summary, selectedBoneId: resolveSelectedBoneId(poseClipState.summary, poseClipState.selectedBoneId), activeMode: 'pose-clip' }
  }
  if (rigEditorState.summary?.hasRig) {
    return { summary: rigEditorState.summary, selectedBoneId: resolveSelectedBoneId(rigEditorState.summary, rigEditorState.selectedBoneId), activeMode: 'none' }
  }
  return { summary: poseClipState.summary, selectedBoneId: resolveSelectedBoneId(poseClipState.summary, poseClipState.selectedBoneId), activeMode: 'none' }
}

export function resolveViewer3DRigOverlayProps(
  state: Viewer3DRigEditorState | Viewer3DRigTargetState,
  callbacks: Viewer3DRigOverlayCallbacks,
  visibility?: Viewer3DRigEditorVisibilityState,
  effectiveNaming?: RigEffectiveNamingResult,
): {
  overlay: RigSelectionOverlayViewModel | null
  onSelectBone: (boneId: RigBoneId) => void
} {
  const isSharedTargetState = 'activeMode' in state
  const shouldShowOverlay = isSharedTargetState ? state.activeMode !== 'none' : visibility?.isOpen
  const overlay = shouldShowOverlay && state.summary?.hasRig ? buildRigSelectionOverlay(state.summary, state.selectedBoneId) : null
  const effectiveSelectedLabel = overlay ? effectiveNaming?.byBoneId[overlay.selectedBoneId]?.label : undefined
  return {
    overlay: overlay && effectiveSelectedLabel ? { ...overlay, selectedLabel: effectiveSelectedLabel } : overlay,
    onSelectBone: callbacks.onSelectBone ?? (() => undefined),
  }
}

export async function writeViewer3DRigRenameSidecar({
  state,
  createdAt = new Date().toISOString(),
  writer,
}: {
  state: Viewer3DRigEditorState
  createdAt?: string
  writer: (request: RigRenameSidecarWriteRequest) => Promise<RigRenameSidecarWriteResult>
}): Promise<RigRenameSidecarWriteResult> {
  const summary = state.summary
  const validation = summary?.hasRig ? validateRigRenamePlan(summary, state.renamePlan) : { valid: false, errors: [] }
  if (!summary?.hasRig || !summary.sourceWorkspacePath || !validation.valid) {
    return { success: false, error: 'Rig rename sidecar requires a valid source-backed alias plan.' }
  }

  const sidecar = buildRigRenameSidecarV1({ summary, plan: state.renamePlan, createdAt })
  const request: RigRenameSidecarWriteRequest = {
    sidecarWorkspacePath: createRigRenameSidecarWorkspacePath(summary.sourceWorkspacePath),
    sourceWorkspacePath: summary.sourceWorkspacePath,
    sidecar,
  }

  return writer(request)
}

export function resolveViewer3DRigHydrationRequest(
  summary?: RigSkeletonSummary,
  semanticHydrationSource?: Viewer3DSemanticHydrationSource,
): RigRenameSidecarReadRequest | null {
  if (!summary?.hasRig || !summary.sourceWorkspacePath) return null
  if (semanticHydrationSource?.sourceKind === 'kimodo-source') return null
  return {
    sidecarWorkspacePath: createRigRenameSidecarWorkspacePath(summary.sourceWorkspacePath),
    sourceWorkspacePath: summary.sourceWorkspacePath,
  }
}

export function resolveViewer3DPoseClipHydrationRequest(summary?: RigSkeletonSummary): PoseClipSidecarReadRequest | null {
  if (!summary?.hasRig || !summary.sourceWorkspacePath) return null
  const sidecarWorkspacePath = createPoseClipSidecarWorkspacePath(summary.sourceWorkspacePath)
  if (!sidecarWorkspacePath) return null
  const legacySidecarWorkspacePath = createLegacyPoseClipSidecarWorkspacePath(summary.sourceWorkspacePath)
  return {
    sidecarWorkspacePath,
    ...(legacySidecarWorkspacePath && legacySidecarWorkspacePath !== sidecarWorkspacePath ? { legacySidecarWorkspacePath } : {}),
    sourceWorkspacePath: summary.sourceWorkspacePath,
  }
}

export function resolveViewer3DMotionRetargetHydrationRequest(summary?: RigSkeletonSummary, session?: MotionRetargetSession): MotionRetargetSidecarReadRequest | null {
  if (!summary?.hasRig || !summary.sourceWorkspacePath) return null
  return {
    sidecarWorkspacePath: createViewer3DMotionRetargetSidecarWorkspacePath(summary.sourceWorkspacePath, session, summary.skeletonContextId),
    sourceWorkspacePath: summary.sourceWorkspacePath,
  }
}

export function createViewer3DMotionRetargetCorrectionIdentity({
  summary,
  session,
}: {
  summary?: RigSkeletonSummary
  session?: MotionRetargetSession
}): MotionRetargetCorrectionIdentityV1 | undefined {
  if (!summary?.hasRig || !summary.sourceWorkspacePath || !session) return undefined
  return createMotionRetargetCorrectionIdentity({
    sourceWorkspacePath: summary.sourceWorkspacePath,
    skeletonContextId: summary.skeletonContextId,
    artifact: session.artifact,
  })
}

export function resolveViewer3DRigMetaHydrationRequest(
  summary?: RigSkeletonSummary,
  semanticHydrationSource?: Viewer3DSemanticHydrationSource,
): RigMetaSidecarReadRequest | null {
  if (!summary?.hasRig || !summary.sourceWorkspacePath) return null
  return { sourceWorkspacePath: semanticHydrationSource?.semanticSourceWorkspacePath ?? summary.sourceWorkspacePath }
}

export function createViewer3DRigHydrationToken({
  modelUrl,
  summary,
  semanticSourceWorkspacePath,
}: {
  modelUrl: string | null
  summary?: RigSkeletonSummary
  semanticSourceWorkspacePath?: string
}): Viewer3DRigHydrationToken | null {
  if (!summary?.hasRig || !summary.sourceWorkspacePath) return null
  return {
    modelUrl,
    sourceWorkspacePath: summary.sourceWorkspacePath,
    semanticSourceWorkspacePath: semanticSourceWorkspacePath ?? summary.sourceWorkspacePath,
    skeletonContextId: summary.skeletonContextId,
  }
}

export const createViewer3DRigMetaHydrationToken = createViewer3DRigHydrationToken
export const createViewer3DPoseClipHydrationToken = createViewer3DRigHydrationToken
export const createViewer3DMotionRetargetHydrationToken = createViewer3DRigHydrationToken

export function areViewer3DRigHydrationTokensEqual(
  left: Viewer3DRigHydrationToken | null,
  right: Viewer3DRigHydrationToken | null,
): boolean {
  return Boolean(
    left &&
    right &&
      left.modelUrl === right.modelUrl &&
      left.sourceWorkspacePath === right.sourceWorkspacePath &&
      left.semanticSourceWorkspacePath === right.semanticSourceWorkspacePath &&
      left.skeletonContextId === right.skeletonContextId,
  )
}

export function applyViewer3DRigHydrationResult({
  state,
  result,
  token,
  currentToken,
}: {
  state: Viewer3DRigEditorState
  result: RigRenameSidecarReadResult
  token: Viewer3DRigHydrationToken | null
  currentToken: Viewer3DRigHydrationToken | null
}): {
  state: Viewer3DRigEditorState
  warning: Viewer3DRigHydrationWarning | null
  stale: boolean
  dirtySkipped: boolean
} {
  if (!areViewer3DRigHydrationTokensEqual(token, currentToken)) {
    return { state, warning: null, stale: true, dirtySkipped: false }
  }

  if (!state.summary?.hasRig || !token) {
    return { state, warning: null, stale: false, dirtySkipped: false }
  }

  if (!result.success) {
    return { state, warning: { status: 'warning', messages: [result.error] }, stale: false, dirtySkipped: false }
  }

  if (result.status === 'not-found') {
    return { state, warning: null, stale: false, dirtySkipped: false }
  }

  if (state.isRenamePlanDirty) {
    return { state, warning: null, stale: false, dirtySkipped: true }
  }

  const hydrated = hydrateRigRenamePlanFromSidecar(state.summary, result.sidecar, { sourceWorkspacePath: token.sourceWorkspacePath })
  if (!hydrated.valid) {
    return { state, warning: { status: 'warning', messages: hydrated.warnings }, stale: false, dirtySkipped: false }
  }

  return {
    state: reduceViewer3DRigEditorState(state, { type: 'hydrate-aliases', plan: hydrated.plan }),
    warning: null,
    stale: false,
    dirtySkipped: false,
  }
}

export function applyViewer3DRigMetaHydrationResult({
  state,
  result,
  token,
  currentToken,
}: {
  state: Viewer3DRigEditorState
  result: RigMetaSidecarReadResult
  token: Viewer3DRigHydrationToken | null
  currentToken: Viewer3DRigHydrationToken | null
}): {
  state: Viewer3DRigEditorState
  warning: Viewer3DRigHydrationWarning | null
  stale: boolean
} {
  if (!areViewer3DRigHydrationTokensEqual(token, currentToken)) {
    return { state, warning: null, stale: true }
  }

  if (!state.summary?.hasRig || !token) {
    return { state: { ...state, rigMetaNamingByBoneId: EMPTY_RIG_META_NAMING }, warning: null, stale: false }
  }

  if (!result.success) {
    return {
      state: { ...state, rigMetaNamingByBoneId: EMPTY_RIG_META_NAMING },
      warning: { status: 'warning', messages: [result.message] },
      stale: false,
    }
  }

  if (result.status === 'not-found') {
    return { state: { ...state, rigMetaNamingByBoneId: EMPTY_RIG_META_NAMING }, warning: null, stale: false }
  }

  const normalized = normalizeRigMetaNaming(result.rigMeta, {
    expectedSourceWorkspacePath: token.semanticSourceWorkspacePath,
    expectedSkeletonContextId: token.semanticSourceWorkspacePath === token.sourceWorkspacePath ? token.skeletonContextId
      : token.skeletonContextId.replace(`rig:${token.sourceWorkspacePath}|`, `rig:${token.semanticSourceWorkspacePath}|`),
    summary: state.summary,
  })
  const warnings = [...new Set([...result.warnings, ...normalized.warnings])]
  const warning = warnings.length > 0 ? { status: 'warning' as const, messages: warnings } : null

  return {
    state: { ...state, rigMetaNamingByBoneId: normalized.namingByBoneId },
    warning,
    stale: false,
  }
}

export async function writeViewer3DPoseClipSidecar({
  state,
  createdAt = new Date().toISOString(),
  writer,
}: {
  state: Viewer3DPoseClipState
  createdAt?: string
  writer: (request: PoseClipSidecarWriteRequest) => Promise<PoseClipSidecarWriteResult>
}): Promise<PoseClipSidecarWriteResult> {
  const summary = state.summary
  if (!summary?.hasRig || !summary.sourceWorkspacePath || state.plan.keyframes.length === 0) {
    return { success: false, error: 'Pose clip sidecar requires a valid source-backed rig and at least one keyframe.' }
  }
  const sidecarWorkspacePath = createPoseClipSidecarWorkspacePath(summary.sourceWorkspacePath)
  if (!sidecarWorkspacePath) {
    return { success: false, error: 'Pose clip sidecar requires a safe workspace-relative source path.' }
  }

  const sidecar = buildPoseClipSidecarV1({ summary, plan: state.plan, createdAt }) as unknown as PoseClipSidecarV1
  return writer({
    sidecarWorkspacePath,
    sourceWorkspacePath: summary.sourceWorkspacePath,
    sidecar: sidecar as unknown as PoseClipSidecarWriteRequest['sidecar'],
  })
}

export async function writeViewer3DMotionRetargetPoseClipCompanion({
  state,
  createdAt = new Date().toISOString(),
  writer,
}: {
  state: Viewer3DMotionRetargetState
  createdAt?: string
  writer: (request: PoseClipSidecarWriteRequest) => Promise<PoseClipSidecarWriteResult>
}): Promise<PoseClipSidecarWriteResult> {
  const disabledReason = resolveViewer3DMotionRetargetPoseClipCompanionDisabledReason(state)
  if (disabledReason) return { success: false, error: disabledReason }

  const derivation = state.summary?.hasRig && state.session
      ? deriveKimodoPoseClipCompanionV1({
          summary: state.summary,
          artifact: state.session.artifact,
          createdAt,
          sourceBones: state.session.sourceBones,
          mappings: state.session.mappings,
        })
    : null

  if (!state.summary?.sourceWorkspacePath || !derivation?.available || !derivation.sidecar || !derivation.sidecarWorkspacePath) {
    return { success: false, error: MOTION_RETARGET_COMPANION_METADATA_UNAVAILABLE }
  }

  return writer({
    sidecarWorkspacePath: derivation.sidecarWorkspacePath,
    sourceWorkspacePath: state.summary.sourceWorkspacePath,
    sidecar: derivation.sidecar as PoseClipSidecarWriteRequest['sidecar'],
  })
}

export async function writeViewer3DMotionRetargetSidecar({
  state,
  createdAt = new Date().toISOString(),
  writer,
}: {
  state: Viewer3DMotionRetargetState
  createdAt?: string
  writer: (request: MotionRetargetSidecarWriteRequest) => Promise<MotionRetargetSidecarWriteResult>
}): Promise<MotionRetargetSidecarWriteResult> {
  const disabledReason = resolveViewer3DMotionRetargetSaveDisabledReason(state)
  if (disabledReason) return { success: false, error: disabledReason }

  const summary = state.summary!
  const session = state.session!
  const sourceWorkspacePath = summary.sourceWorkspacePath!

  return writer({
    sidecarWorkspacePath: createViewer3DMotionRetargetSidecarWorkspacePath(sourceWorkspacePath, session, summary.skeletonContextId),
    sourceWorkspacePath,
    sidecar: createMotionRetargetSidecarV1({
      identity: createMotionRetargetCorrectionIdentity({ sourceWorkspacePath, skeletonContextId: summary.skeletonContextId, artifact: session.artifact }),
      session,
      sourceWorkspacePath,
      createdAt,
      corrections: state.corrections,
      warnings: dedupeViewer3DWarnings([...state.diagnosticsMessages, ...session.warnings]),
    }) as MotionRetargetSidecarWriteRequest['sidecar'],
  })
}

export function applyViewer3DPoseClipHydrationResult({
  state,
  result,
  token,
  currentToken,
}: {
  state: Viewer3DPoseClipState
  result: PoseClipSidecarReadResult
  token: Viewer3DRigHydrationToken | null
  currentToken: Viewer3DRigHydrationToken | null
}): {
  state: Viewer3DPoseClipState
  warning: Viewer3DRigHydrationWarning | null
  stale: boolean
} {
  if (!areViewer3DRigHydrationTokensEqual(token, currentToken)) {
    return { state, warning: null, stale: true }
  }
  if (!state.summary?.hasRig || !token) return { state, warning: null, stale: false }
  if (!result.success) {
    const warning = { status: 'warning' as const, messages: [result.error] }
    return { state: { ...state, warning, loadState: 'error', loadError: result.error }, warning, stale: false }
  }
  if (result.status === 'not-found') return { state: { ...state, loadState: 'idle' }, warning: null, stale: false }

  const hydrated = hydratePoseClipPlanFromSidecar(state.summary, result.sidecar, {
    sourceWorkspacePath: token.sourceWorkspacePath,
    skeletonContextId: token.skeletonContextId,
  })
  const warning = hydrated.warnings.length > 0 ? { status: 'warning' as const, messages: hydrated.warnings } : null
  if (!hydrated.valid) {
    return { state: { ...state, warning, loadState: 'error', loadError: hydrated.warnings.join(' ') }, warning, stale: false }
  }
  return {
    state: { ...state, plan: hydrated.plan, selectedKeyframeId: undefined, currentTimeSeconds: 0, previewState: 'idle', loadState: 'loaded', warning, loadError: undefined },
    warning,
    stale: false,
  }
}

export function applyViewer3DMotionRetargetHydrationResult({
  state,
  result,
  token,
  currentToken,
  showNotFoundMessage = true,
}: {
  state: Viewer3DMotionRetargetState
  result: MotionRetargetSidecarReadResult
  token: Viewer3DRigHydrationToken | null
  currentToken: Viewer3DRigHydrationToken | null
  showNotFoundMessage?: boolean
}): {
  state: Viewer3DMotionRetargetState
  stale: boolean
  dirtySkipped?: boolean
} {
  if (!areViewer3DRigHydrationTokensEqual(token, currentToken)) {
    return { state, stale: true }
  }
  if (!state.summary?.hasRig || !token) return { state, stale: false }

  if (!result.success) {
    return {
      state: {
        ...state,
        diagnosticsMessages: [result.error],
        loadState: 'error',
        loadMessage: result.error,
      },
      stale: false,
    }
  }

  if (result.status === 'not-found') {
    const message = `Motion retarget sidecar not found at ${result.sidecarWorkspacePath}.`
    return {
      state: {
        ...state,
        diagnosticsMessages: showNotFoundMessage ? [message] : state.diagnosticsMessages,
        loadState: 'idle',
        loadMessage: showNotFoundMessage ? message : state.loadMessage,
      },
      stale: false,
    }
  }

  const savedIdentity = createMotionRetargetCorrectionIdentity({ sourceWorkspacePath: state.summary.sourceWorkspacePath,
    skeletonContextId: state.summary.skeletonContextId, artifact: result.sidecar.artifact })
  const currentIdentity = createViewer3DMotionRetargetCorrectionIdentity({ summary: state.summary, session: state.session })
  if (normalizeViewer3DWorkspacePath(result.sidecar.source.workspacePath) !== state.summary.sourceWorkspacePath
    || (currentIdentity && savedIdentity.key !== currentIdentity.key)) {
    const message = 'Motion Retarget sidecar belongs to a different workflow/artifact identity.'
    return { state: { ...state, loadState: 'error', loadMessage: message }, stale: false }
  }
  const expectedIdentity = createViewer3DMotionRetargetCorrectionIdentity({ summary: state.summary, session: state.session ?? createMotionRetargetSession({
    artifact: result.sidecar.artifact,
    targetSummary: state.summary,
    sourceBones: result.sidecar.sourceBones,
    snapshot: result.sidecar.session,
  }) })
  const hydrated = result.sidecar.identity && expectedIdentity
    ? hydrateMotionRetargetSessionSnapshotFromSidecar({ sidecar: result.sidecar as Parameters<typeof hydrateMotionRetargetSessionSnapshotFromSidecar>[0]['sidecar'], identity: expectedIdentity })
    : null
  if (hydrated?.status === 'identity-mismatch') {
    const message = hydrated.warnings.join(' ')
    return {
      state: { ...state, diagnosticsMessages: hydrated.warnings, loadState: 'error', loadMessage: message },
      stale: false,
    }
  }
  if (state.correctionState.dirty) return { state, stale: false, dirtySkipped: true }

  const session = createMotionRetargetSession({
    artifact: result.sidecar.artifact,
    targetSummary: state.summary,
    sourceBones: hydrated?.status === 'loaded' ? hydrated.sourceBones : result.sidecar.sourceBones,
    snapshot: hydrated?.status === 'loaded' ? hydrated.snapshot : result.sidecar.session,
  })
  const diagnosticsMessages = result.sidecar.warnings.filter((warning) => !session.warnings.includes(warning))
  const identity = createViewer3DMotionRetargetCorrectionIdentity({ summary: state.summary, session })

  return {
    state: {
      ...state,
      session,
      identity,
      corrections: hydrated?.status === 'loaded' ? hydrated.corrections : structuredClone(DEFAULT_MOTION_RETARGET_CORRECTIONS),
      correctionState: resolveMotionRetargetCorrectionState({ status: 'loaded', sidecarWorkspacePath: result.sidecarWorkspacePath }),
      selectedSourceBoneId: session.sourceBones[0]?.sourceBoneId,
      diagnosticsMessages,
      loadState: 'loaded',
      loadMessage: `Loaded motion retarget sidecar: ${result.sidecarWorkspacePath}`,
    },
    stale: false,
  }
}

export function startViewer3DPoseClipPreview({
  state,
  bonesById,
  gltfActions,
  gltfAnimationPlaying,
  timeSeconds,
}: {
  state: Viewer3DPoseClipState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  gltfActions: readonly AnimationActionLike[]
  gltfAnimationPlaying: boolean
  timeSeconds?: number
}): {
  state: Viewer3DPoseClipState
  poseSnapshot: PoseClipQuaternionSnapshot
  gltfAnimationSnapshot: AnimationIsolationSnapshot
} {
  const poseSnapshot = takePoseClipQuaternionSnapshot(bonesById)
  const gltfAnimationSnapshot = isolateAnimationForPoseClipPreview(gltfActions, gltfAnimationPlaying)
  const nextTime = timeSeconds ?? state.currentTimeSeconds
  evaluatePoseClipPreview({ plan: state.plan, bonesById, timeSeconds: nextTime })
  return {
    state: { ...state, previewState: 'playing', currentTimeSeconds: nextTime },
    poseSnapshot,
    gltfAnimationSnapshot,
  }
}

export function resetViewer3DPoseClipPreview({
  state,
  bonesById,
  snapshot,
}: {
  state: Viewer3DPoseClipState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>
}): { state: Viewer3DPoseClipState; restoredBoneIds: RigBoneId[] } {
  const reset = resetPoseClipPreview({ bonesById, snapshot })
  return { state: { ...state, previewState: 'idle', currentTimeSeconds: 0 }, restoredBoneIds: reset.restoredBoneIds }
}

export const takeViewer3DPoseClipSnapshot = takePoseClipQuaternionSnapshot

export function startViewer3DMotionRetargetPreview({
  state,
  bonesById,
  poseSnapshot,
  gltfActions,
  gltfAnimationPlaying,
  timeSeconds,
}: {
  state: Viewer3DMotionRetargetState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  poseSnapshot: MotionRetargetTransformSnapshot | null
  gltfActions: readonly AnimationActionLike[]
  gltfAnimationPlaying: boolean
  timeSeconds?: number
}): {
  state: Viewer3DMotionRetargetState
  poseSnapshot: MotionRetargetTransformSnapshot
  gltfAnimationSnapshot: AnimationIsolationSnapshot
  preview: EvaluatePoseClipPreviewResult | null
} {
  const previewClip = resolveViewer3DMotionRetargetPreviewClip(state)
  const snapshot = poseSnapshot ?? takeMotionRetargetPreviewSnapshot(bonesById)
  const gltfAnimationSnapshot = isolateAnimationForPoseClipPreview(gltfActions, gltfAnimationPlaying)
  if (!previewClip.available || !previewClip.plan) {
    return { state: { ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 }, poseSnapshot: snapshot, gltfAnimationSnapshot, preview: null }
  }
  const nextTime = clampPoseClipTime(timeSeconds ?? state.previewCurrentTimeSeconds, previewClip.plan.clip.durationSeconds)
  const preview = restoreThenEvaluateMotionRetargetPreview({
    plan: previewClip.plan,
    bonesById,
    snapshot,
    timeSeconds: nextTime,
    summary: state.summary,
    corrections: state.corrections,
  }).preview
  return {
    state: { ...state, previewState: 'playing', previewCurrentTimeSeconds: nextTime },
    poseSnapshot: snapshot,
    gltfAnimationSnapshot,
    preview,
  }
}

export function scrubViewer3DMotionRetargetPreviewTime({
  state,
  bonesById,
  poseSnapshot,
  gltfActions,
  gltfAnimationPlaying,
  timeSeconds,
}: {
  state: Viewer3DMotionRetargetState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  poseSnapshot: MotionRetargetTransformSnapshot | null
  gltfActions: readonly AnimationActionLike[]
  gltfAnimationPlaying: boolean
  timeSeconds: number
}): {
  state: Viewer3DMotionRetargetState
  poseSnapshot: MotionRetargetTransformSnapshot
  gltfAnimationSnapshot: AnimationIsolationSnapshot
  preview: EvaluatePoseClipPreviewResult | null
} {
  const previewClip = resolveViewer3DMotionRetargetPreviewClip(state)
  const snapshot = poseSnapshot ?? takeMotionRetargetPreviewSnapshot(bonesById)
  const gltfAnimationSnapshot = isolateAnimationForPoseClipPreview(gltfActions, gltfAnimationPlaying)
  if (!previewClip.available || !previewClip.plan) {
    return { state: { ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 }, poseSnapshot: snapshot, gltfAnimationSnapshot, preview: null }
  }
  const nextTime = clampPoseClipTime(timeSeconds, previewClip.plan.clip.durationSeconds)
  const preview = restoreThenEvaluateMotionRetargetPreview({
    plan: previewClip.plan,
    bonesById,
    snapshot,
    timeSeconds: nextTime,
    summary: state.summary,
    corrections: state.corrections,
  }).preview
  return {
    state: { ...state, previewState: 'paused', previewCurrentTimeSeconds: nextTime },
    poseSnapshot: snapshot,
    gltfAnimationSnapshot,
    preview,
  }
}

export function resetViewer3DMotionRetargetPreview({
  state,
  bonesById,
  snapshot,
}: {
  state: Viewer3DMotionRetargetState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: MotionRetargetTransformSnapshot
}): { state: Viewer3DMotionRetargetState; restoredBoneIds: RigBoneId[] } {
  const reset = resetMotionRetargetPreview({ bonesById, snapshot })
  return { state: { ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 }, restoredBoneIds: reset.restoredBoneIds }
}

export function resetViewer3DActiveMotionPlayback({
  state,
  activeBackend,
  bonesById,
  localSnapshot,
  animation,
}: {
  state: Viewer3DMotionRetargetState
  activeBackend: MotionPlaybackBackend
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  localSnapshot: Parameters<typeof resetMotionRetargetPreview>[0]['snapshot'] | null
  animation: Viewer3DAnimationControls & { playing: boolean }
}): {
  state: Viewer3DMotionRetargetState
  animationPlaying: false
  localSnapshot: null
  reset?: AnimationPlaybackResetResult
  restoredBoneIds?: RigBoneId[]
} {
  if (activeBackend === 'animated-glb') {
    const reset = resetAnimationPlayback({ actions: animation.actions, mixer: animation.mixer })
    return {
      state: { ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 },
      animationPlaying: false,
      localSnapshot: null,
      reset,
    }
  }

  const reset = localSnapshot
    ? resetMotionRetargetPreview({ bonesById, snapshot: localSnapshot })
    : { restoredBoneIds: [] as RigBoneId[] }
  return {
    state: { ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 },
    animationPlaying: false,
    localSnapshot: null,
    restoredBoneIds: reset.restoredBoneIds,
  }
}

export function shouldResetViewer3DMotionRetargetPreviewForVisibilityChange({
  wasOpen,
  isOpen,
}: {
  wasOpen: boolean
  isOpen: boolean
}): boolean {
  return wasOpen && !isOpen
}

export function resetViewer3DScopedMotionRetargetPreviewOnClose({
  state,
  bonesById,
  localSnapshot,
  globalAnimationPlaying,
}: {
  state: Viewer3DMotionRetargetState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  localSnapshot: Parameters<typeof resetMotionRetargetPreview>[0]['snapshot'] | null
  globalAnimationPlaying: boolean
}): {
  state: Viewer3DMotionRetargetState
  localSnapshot: null
  globalAnimationPlaying: boolean
  restoredBoneIds: RigBoneId[]
} {
  const reset = localSnapshot
    ? resetMotionRetargetPreview({ bonesById, snapshot: localSnapshot })
    : { restoredBoneIds: [] as RigBoneId[] }
  return {
    state: { ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 },
    localSnapshot: null,
    globalAnimationPlaying,
    restoredBoneIds: reset.restoredBoneIds,
  }
}

export { takeMotionRetargetPreviewSnapshot }

export function scrubViewer3DPoseClipPreviewTime({
  state,
  bonesById,
  poseSnapshot,
  gltfActions,
  gltfAnimationPlaying,
  timeSeconds,
}: {
  state: Viewer3DPoseClipState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  poseSnapshot: PoseClipQuaternionSnapshot | null
  gltfActions: readonly AnimationActionLike[]
  gltfAnimationPlaying: boolean
  timeSeconds: number
}): {
  state: Viewer3DPoseClipState
  poseSnapshot: PoseClipQuaternionSnapshot
  gltfAnimationSnapshot: AnimationIsolationSnapshot
  preview: EvaluatePoseClipPreviewResult
  restoredBoneIds: RigBoneId[]
} {
  const snapshot = poseSnapshot ?? takePoseClipQuaternionSnapshot(bonesById)
  const gltfAnimationSnapshot = isolateAnimationForPoseClipPreview(gltfActions, gltfAnimationPlaying)
  const nextState = reduceViewer3DPoseClipState(state, { type: 'set-current-time', timeSeconds })
  const evaluated = restoreThenEvaluatePoseClipPreview({
    plan: nextState.plan,
    bonesById,
    snapshot,
    timeSeconds: nextState.currentTimeSeconds,
  })
  return {
    state: { ...nextState, previewState: 'paused' },
    poseSnapshot: snapshot,
    gltfAnimationSnapshot,
    preview: evaluated.preview,
    restoredBoneIds: evaluated.restoredBoneIds,
  }
}

export function selectViewer3DPoseClipKeyframePreview({
  state,
  summary,
  bonesById,
  poseSnapshot,
  gltfActions,
  gltfAnimationPlaying,
  keyframeId,
}: {
  state: Viewer3DPoseClipState
  summary: RigSkeletonSummary
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  poseSnapshot: PoseClipQuaternionSnapshot | null
  gltfActions: readonly AnimationActionLike[]
  gltfAnimationPlaying: boolean
  keyframeId: string
}): {
  state: Viewer3DPoseClipState
  poseSnapshot: PoseClipQuaternionSnapshot
  gltfAnimationSnapshot: AnimationIsolationSnapshot
  preview: EvaluatePoseClipPreviewResult
  restoredBoneIds: RigBoneId[]
} {
  const nextState = reduceViewer3DPoseClipState(state, { type: 'select-keyframe', summary, keyframeId })
  return scrubViewer3DPoseClipPreviewTime({
    state: nextState,
    bonesById,
    poseSnapshot,
    gltfActions,
    gltfAnimationPlaying,
    timeSeconds: nextState.currentTimeSeconds,
  })
}

export function updateViewer3DSelectedPoseClipKeyframePreview({
  state,
  summary,
  bonesById,
  poseSnapshot,
  gltfActions,
  gltfAnimationPlaying,
  boneId,
  rotation,
}: {
  state: Viewer3DPoseClipState
  summary: RigSkeletonSummary
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  poseSnapshot: PoseClipQuaternionSnapshot | null
  gltfActions: readonly AnimationActionLike[]
  gltfAnimationPlaying: boolean
  boneId: RigBoneId
  rotation: PoseClipQuaternion
}): {
  state: Viewer3DPoseClipState
  poseSnapshot: PoseClipQuaternionSnapshot
  gltfAnimationSnapshot: AnimationIsolationSnapshot
  preview: EvaluatePoseClipPreviewResult
  restoredBoneIds: RigBoneId[]
} {
  const nextState = reduceViewer3DPoseClipState(state, { type: 'update-selected-keyframe', summary, boneId, rotation })
  return scrubViewer3DPoseClipPreviewTime({
    state: nextState,
    bonesById,
    poseSnapshot,
    gltfActions,
    gltfAnimationPlaying,
    timeSeconds: nextState.currentTimeSeconds,
  })
}

export function applyViewer3DPoseClipLocalRotation({
  state,
  bonesById,
  poseSnapshot,
  boneId,
  axis,
  degreesDelta,
}: {
  state: Viewer3DPoseClipState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  poseSnapshot: PoseClipQuaternionSnapshot | null
  boneId: RigBoneId
  axis: PoseClipRotationAxis
  degreesDelta: number
}): { state: Viewer3DPoseClipState; poseSnapshot: PoseClipQuaternionSnapshot | null; result: ApplyLocalPoseClipRotationResult } {
  const nextSnapshot = poseSnapshot ?? takePoseClipQuaternionSnapshot(bonesById)
  const result = applyLocalPoseClipRotation({ bonesById, boneId, axis, degreesDelta })
  return { state: { ...state, previewState: 'paused' }, poseSnapshot: nextSnapshot, result }
}

export function resetViewer3DPoseClipSelectedBone({
  state,
  bonesById,
  snapshot,
  boneId,
}: {
  state: Viewer3DPoseClipState
  bonesById: ReadonlyMap<RigBoneId, THREE.Bone>
  snapshot: ReadonlyMap<RigBoneId, THREE.Quaternion>
  boneId: RigBoneId
}): { state: Viewer3DPoseClipState; restoredBoneIds: RigBoneId[] } {
  const reset = resetPoseClipSelectedBone({ bonesById, snapshot, boneId })
  return { state: { ...state, previewState: 'idle' }, restoredBoneIds: reset.restoredBoneIds }
}

function preserveValidRigSelection(state: Viewer3DRigEditorState): Viewer3DRigEditorState {
  if (!state.summary?.hasRig) return createViewer3DRigEditorState(state.summary)
  const selectedBoneId = resolveValidRigSelectedBoneId(state.summary, state.selectedBoneId)
  if (selectedBoneId === state.selectedBoneId) return state
  return { ...state, selectedBoneId }
}

function resolveDefaultRigSelectedBoneId(summary?: RigSkeletonSummary): RigBoneId | undefined {
  if (!summary?.hasRig) return undefined
  return undefined
}

function resolveValidRigSelectedBoneId(summary: RigSkeletonSummary | undefined, selectedBoneId: RigBoneId | undefined): RigBoneId | undefined {
  if (!summary?.hasRig) return undefined
  return selectedBoneId && summary.bones.some((bone) => bone.boneId === selectedBoneId)
    ? selectedBoneId
    : resolveDefaultRigSelectedBoneId(summary)
}

export function resolveViewer3DPresentation(target: ViewerAssetTarget | ViewerModelSource): Viewer3DPresentation {
  return resolveViewerTargetPresentation(target)
}

export function resolveViewer3DRigSourceWorkspacePath(target: { modelUrl: string | null; workspacePath?: string }, apiUrl?: string, workspaceDir?: string): string | undefined {
  return resolveViewerRigSourceWorkspacePath(target, { apiUrl, workspaceDir })
}

function isSafeRigSourceWorkspacePath(path: string): boolean {
  return isSafeViewerWorkspaceRelativePath(path, { meshOnly: true })
}

function normalizeServeFileWorkspaceMeshPathFromAbsolutePath(absolutePath: string, workspaceDir?: string): string | undefined {
  return resolveViewerWorkspacePathFromAbsoluteValue(absolutePath, { workspaceDir, meshOnly: true })
}

function resolveViewer3DWorkspaceMeshPathFromUrl(modelUrl: string | null | undefined, apiUrl?: string, workspaceDir?: string): string | undefined {
  return resolveViewerAssetWorkspacePathFromUrl(modelUrl, { apiUrl, workspaceDir })
}

export function resolveViewer3DOverlayLayout({
  modelUrl,
  hasEditRail,
  poseClipVisibility,
  rigEditorVisibility,
  motionRetargetVisibility,
}: {
  modelUrl: string | null
  hasEditRail: boolean
  poseClipVisibility?: Viewer3DPoseClipVisibilityState
  rigEditorVisibility?: Viewer3DRigEditorVisibilityState
  motionRetargetVisibility?: Viewer3DMotionRetargetVisibilityState
}): Viewer3DOverlayLayout {
  const editRailClassName = modelUrl && hasEditRail ? 'right-4 top-1/2 -translate-y-1/2 z-20' : null
  const rightOverlayClassName = editRailClassName ? 'right-16' : 'right-4'
  const isPoseClipActionRailOpen = Boolean(poseClipVisibility?.isOpen)
  const motionRetargetPanelClassName = motionRetargetVisibility?.isOpen && rigEditorVisibility?.isOpen
    ? `${rightOverlayClassName} top-[22rem]`
    : `${rightOverlayClassName} top-4`

  return {
    viewRailClassName: 'left-4 top-1/2 -translate-y-1/2 z-20',
    editRailClassName,
    editPanelClassName: rightOverlayClassName,
    rigEditorPanelSlot: 'top-right',
    motionRetargetPanelSlot: 'top-right-stack',
    motionRetargetPanelClassName,
    poseClipPanelSlot: 'bottom-drawer',
    poseClipPanelClassName: 'left-4 right-16 bottom-4 max-h-[34vh]',
    commonViewportUsability: 'capped-internal-scroll',
    hintClassName: rightOverlayClassName,
    rigOverlayClassName: isPoseClipActionRailOpen ? 'left-4 bottom-24 z-20' : 'left-4 top-24 z-20',
    rigOverlaySafeArea: isPoseClipActionRailOpen ? 'above-minimized-pose-clip-controls' : 'below-top-left-toolbar',
  }
}

export const resolveViewer3DLandmarkMarkers = deriveLandmarkMarkers

function ioError(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback }

type TransformSnapshot = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }

// Keep authored state and its synchronous event-time revision in the same owner.
function useCurrentState<T>(initial: () => T) {
  const [state, setState] = useState(initial)
  const current = useRef(state)
  const update = useCallback((value: T | ((previous: T) => T)) => {
    const next = typeof value === 'function' ? (value as (previous: T) => T)(current.current) : value
    current.current = next
    setState(next)
  }, [])
  return [state, current, update] as const
}

function aliasRevision(plan: RigRenamePlan): string {
  return JSON.stringify(Object.entries(plan.aliases).sort(([left], [right]) => left.localeCompare(right)))
}

function motionRevision(state: Viewer3DMotionRetargetState): string {
  return JSON.stringify({ identity: state.identity, mappings: state.session?.mappings, preview: state.session?.selectedPreview, corrections: state.corrections })
}

function poseRevision(plan: PoseClipPlan): string {
  return JSON.stringify({ skeletonContextId: plan.skeletonContextId, clip: plan.clip, keyframes: plan.keyframes })
}

function artifactWorkspacePath(value: string, workspaceDir?: string): string | null {
  if (!value.startsWith('/') && !/^[A-Za-z]:/.test(value)) return normalizeSceneWorkspacePath(value)
  const root = workspaceDir?.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = value.replace(/\\/g, '/')
  return root && absolute.startsWith(`${root}/`) ? normalizeSceneWorkspacePath(absolute.slice(root.length + 1)) : null
}

// The detached graph borrows originals only until E synchronously clones its own
// resources. No live material/geometry/pose is toggled across an asynchronous call.
function pristineExportView(source: LoadedScene) {
  const scene = cloneSkeleton(source.scene)
  const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  const pair = (original: THREE.Object3D, copy: THREE.Object3D) => {
    // Preserve UUID-based animation binding in this isolated pre-export view.
    copy.uuid = original.uuid
    if (original instanceof THREE.Mesh && copy instanceof THREE.Mesh) {
      copy.geometry = source.originalGeometries.get(original) ?? original.geometry
      const material = source.originalMaterials.get(original) ?? original.material
      copy.material = material
      originalMaterials.set(copy, material)
    }
    original.children.forEach((child, index) => pair(child, copy.children[index]))
  }
  pair(source.scene, scene)
  return { scene, originalMaterials }
}

export default function Viewer3D({
  lightSettings = DEFAULT_LIGHT_SETTINGS, gizmoMode = null, gizmoUndoRef,
  pointLights = [], selectedPointLightId = null, onSelectPointLight, onPointLightsChange,
}: {
  lightSettings?: LightSettings
  gizmoMode?: GizmoMode | null
  gizmoUndoRef?: MutableRefObject<(() => boolean) | null>
  pointLights?: PointLight[]
  selectedPointLightId?: string | null
  onSelectPointLight?: (id: string | null) => void
  onPointLightsChange?: (lights: PointLight[]) => void
}): JSX.Element {
  const { currentJob } = useGeneration()
  const apiUrl = useAppStore(s => s.apiUrl)
  const setStoreMeshStats = useAppStore(s => s.setMeshStats)
  const meshStats = useAppStore(s => s.meshStats)
  const setCurrentJob = useAppStore(s => s.setCurrentJob)
  const selected = useAppStore(s => s.meshSelected)
  const setSelected = useAppStore(s => s.setMeshSelected)
  const checkpointNodeId = useWorkflowRunStore(s => s.activeCheckpointNodeId)
  const checkpoint = useWorkflowRunStore(s => checkpointNodeId ? s.checkpoints[checkpointNodeId] : undefined)
  const baseViewerTarget = resolveViewerAssetTarget({ currentJob, apiUrl })
  const executionId = useWorkflowRunStore(s => s.executionId)
  const motionContext = JSON.stringify([currentJob?.id, baseViewerTarget.modelUrl, executionId, checkpointNodeId, checkpoint?.owner, checkpoint?.substitutionPoint?.inputArtifact])
  const motionContextRef = useRef(motionContext)
  motionContextRef.current = motionContext
  const [motionModel, setMotionModel] = useState<{ context: string; url: string; selectedPreview: MotionRetargetPreviewKind; explicit: boolean } | null>(null)
  const motionModelRef = useRef(motionModel)
  motionModelRef.current = motionModel
  const [workspaceRoot, setWorkspaceRoot] = useState<{ context: string; path?: string } | null>(null)
  const workspaceDir = workspaceRoot?.context === motionContext ? workspaceRoot.path : undefined
  const workflowRunState = useWorkflowRunStore(s => s.runState)
  const workflowJobCurrent = !!executionId && currentJob?.id === executionId
  const checkpointArtifact = checkpoint?.substitutionPoint?.inputArtifact
  const selectedArtifact = workflowJobCurrent && checkpoint?.owner.runId === executionId
    && checkpoint.owner.nodeId === checkpointNodeId && checkpointArtifact?.id === checkpoint.owner.inputArtifactId
    && checkpointArtifact?.versionId === checkpoint.owner.inputVersionId ? checkpointArtifact : undefined
  const viewerTarget = resolveViewerAssetTarget({ currentJob, apiUrl, workspaceDir,
    workflowArtifact: checkpoint ? selectedArtifact : workflowJobCurrent && workflowRunState.status === 'done' ? workflowRunState.artifact : undefined })
  const modelSource = resolveViewerModelSource(viewerTarget)
  const viewerPresentation = resolveViewer3DPresentation(viewerTarget)
  // The selected checkpoint, not a previous scene's/global artifact, owns metadata.
  const kimodoMetadataDescriptor = useMemo(() => resolveViewer3DKimodoMetadataDescriptor({
    apiUrl, modelUrl: viewerPresentation.modelUrl, workspaceDir,
    artifact: selectedArtifact,
  }), [apiUrl, viewerPresentation.modelUrl, workspaceDir, selectedArtifact])
  const descriptorRef = useRef(kimodoMetadataDescriptor)
  descriptorRef.current = kimodoMetadataDescriptor
  const [sourceRigDecision, setSourceRigDecision] = useState<{
    context: string; descriptor: Viewer3DKimodoMetadataDescriptor; preview: LoadedScene
    metadata: Record<string, unknown>; result: Viewer3DKimodoSourceRigFallbackResult
  } | null>(null)
  const sourceRigFallback = sourceRigDecision?.context === motionContext && sourceRigDecision.descriptor === kimodoMetadataDescriptor
    ? sourceRigDecision : null
  const selectedMotionModel = motionModel?.context === motionContext ? motionModel : null
  const authoringPresentation = resolveViewer3DAuthoringPresentation({
    baseModelUrl: viewerPresentation.modelUrl, currentJobId: currentJob?.id,
    motionRetargetPresentation: { modelUrl: selectedMotionModel?.url ?? viewerPresentation.modelUrl, warnings: [] },
    sourceRigFallback: selectedMotionModel?.explicit ? undefined : sourceRigFallback?.result,
  })
  const modelUrl = authoringPresentation.modelUrl
  const [motionRetargetState, motionStateRef, setMotionRetargetState] = useCurrentState(createViewer3DMotionRetargetState)
  const [motionRetargetVisibility, motionVisibilityRef, setMotionRetargetVisibility] = useCurrentState(createViewer3DMotionRetargetVisibilityState)
  const [artifactPreviewState, setArtifactPreviewState] = useState(createViewer3DArtifactPreviewState)
  const motionEpoch = useRef(0)
  const motionIO = useRef<Partial<Record<'save' | 'load' | 'export' | 'preview' | 'download', object>>>({})
  const motionPreviewRef = useRef<{ source: LoadedScene; bones: ReadonlyMap<RigBoneId, THREE.Bone>; snapshot: MotionRetargetTransformSnapshot } | null>(null)
  const animationControlsRef = useRef<{ scene: THREE.Object3D; controls: Viewer3DAnimationControls } | null>(null)
  const handleAnimationControls = useCallback((scene: THREE.Object3D, controls: Viewer3DAnimationControls | null) => {
    if (controls) animationControlsRef.current = { scene, controls }
    else if (animationControlsRef.current?.scene === scene) animationControlsRef.current = null
  }, [])
  const splatWorkspacePath = resolveViewer3DSplatWorkspacePath(viewerTarget, modelUrl, apiUrl, workspaceDir)
  const isSplat = Boolean(splatWorkspacePath) || /\.(ply|splat)(?:[?#]|$)/i.test(modelUrl ?? '')
  const splatUrl = resolveViewer3DSplatUrl(apiUrl, splatWorkspacePath, modelUrl)
  const rigSourceWorkspacePath = resolveViewer3DWorkspaceMeshPathFromUrl(modelUrl, apiUrl, workspaceDir)
  const modelRef = useRef(modelUrl)
  modelRef.current = isSplat ? null : modelUrl
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const splatRef = useRef<SplatViewerHandle | null>(null)
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const [meshObject, setMeshObject] = useState<THREE.Object3D | null>(null)
  const transformHistory = useRef<TransformSnapshot[]>([])
  const pendingTransform = useRef<TransformSnapshot | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('solid')
  const [autoRotate, setAutoRotate] = useState(false)
  const [playingUrl, setPlayingUrl] = useState<string | null>(null)
  const [animationSource, setAnimationSource] = useState<{ url: string | null; available: boolean } | null>(null)
  const [rigSource, setRigSource] = useState<{ url: string | null; stats: RigStats } | null>(null)
  const hasAnimations = !!modelUrl && !isSplat && animationSource?.url === modelUrl && animationSource.available
  const animationPlaying = hasAnimations && playingUrl === modelUrl
  const hasRig = !!modelUrl && !isSplat && rigSource?.url === modelUrl && rigSource.stats.hasRig
  const [loadedSource, sourceRef, setLoadedSource] = useCurrentState<LoadedScene | null>(() => null)
  const liveSource = loadedSource?.url === modelUrl && !isSplat ? loadedSource : null
  const currentMeshObject = liveSource?.scene === meshObject ? meshObject : null
  const hasPostProcessing = Boolean(modelUrl && currentJob)
  const viewportGizmoRenderPriority = resolveViewer3DViewportGizmoRenderPriority(hasPostProcessing)
  const canRenderViewportGizmos = shouldRenderViewer3DViewportGizmos({ modelUrl, hasCurrentJob: Boolean(currentJob), object: currentMeshObject })
  const sceneFrameKey = modelUrl && currentMeshObject ? `${modelUrl}:${currentMeshObject.uuid}` : null
  const isLive = useCallback((source: LoadedScene | null): source is LoadedScene =>
    !!source && sourceRef.current === source && modelRef.current === source.url, [sourceRef])
  useEffect(() => {
    const reader = window.electron?.settings?.get
    const paths = [checkpoint?.substitutionPoint?.inputArtifact.uri, checkpoint?.substitutionPoint?.inputArtifact.legacy?.filePath]
    const needsRoot = viewerPresentation.modelUrl?.includes('/optimize/serve-file?') || paths.some(path => path && !path.startsWith('/workspace/') && (path.startsWith('/') || /^[A-Za-z]:/.test(path)))
    if (!reader || workspaceDir || !needsRoot || (!isSplat && (!liveSource || liveSource.binding.summary.hasRig))) return
    let cancelled = false
    Promise.resolve().then(() => reader()).then(settings => {
      if (!cancelled && motionContextRef.current === motionContext && window.electron?.settings?.get === reader) setWorkspaceRoot({ context: motionContext, path: settings.workspaceDir })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [motionContext, liveSource, workspaceDir, isSplat])
  const poseSessionRef = useRef<PoseClipPreviewSession | null>(null)
  const poseOwnerRef = useRef<THREE.Object3D | null>(null)
  const [rigEditorState, rigStateRef, setRigEditorState] = useCurrentState(createViewer3DRigEditorState)
  const [poseClipState, poseStateRef, setPoseClipState] = useCurrentState(createViewer3DPoseClipState)
  const [rigEditorVisibility, setRigEditorVisibility] = useState(createViewer3DRigEditorVisibilityState)
  const [poseClipVisibility, setPoseClipVisibility] = useState(createViewer3DPoseClipVisibilityState)
  const [selectedRigTarget, setSelectedRigTarget] = useState(createViewer3DSelectedRigTargetState)
  const [rigRenameSaveState, setRigRenameSaveState] = useState<RigRenameSaveState>({ status: 'idle' })
  const [rigRenameLoadState, setRigRenameLoadState] = useState<PoseClipLoadState>('idle')
  const [rigRenameHydrationWarning, setRigRenameHydrationWarning] = useState<Viewer3DRigHydrationWarning | null>(null)
  const [rigMetaHydrationWarning, setRigMetaHydrationWarning] = useState<Viewer3DRigHydrationWarning | null>(null)
  const aliasBaseline = useRef('[]')
  const poseBaseline = useRef(poseRevision(poseClipState.plan))
  const aliasIO = useRef<object | null>(null)
  const poseIO = useRef<object | null>(null)
  const editIO = useRef<object | null>(null)
  const [sceneEditMode, setSceneEditMode] = useState<'idle' | 'editing'>('idle')
  const [editPlan, setEditPlan] = useState<EditPlan | null>(null)
  const [saveState, setSaveState] = useState<SceneEditSaveState>({ status: 'idle' })
  const sceneParts = liveSource?.parts ?? []

  const releaseMotion = useCallback(() => {
    const owner = motionPreviewRef.current
    if (owner) resetMotionRetargetPreview({ bonesById: owner.bones, snapshot: owner.snapshot })
    motionPreviewRef.current = null
    if (owner && poseOwnerRef.current === owner.source.scene) poseOwnerRef.current = null
  }, [])
  const releasePose = useCallback(() => {
    if (poseSessionRef.current) restorePoseClipPreviewSession(poseSessionRef.current)
    poseSessionRef.current = null
    poseOwnerRef.current = null
  }, [])
  const handlePoseClipPreviewReset = useCallback(() => {
    releasePose()
    setPoseClipState(current => ({ ...current, previewState: 'idle', currentTimeSeconds: 0 }))
  }, [releasePose, setPoseClipState])
  const handleSceneReady = useCallback((source: LoadedScene | null) => {
    releaseMotion(); releasePose()
    motionEpoch.current++; motionIO.current = {}
    setMotionRetargetState(createViewer3DMotionRetargetState(source?.binding.summary))
    setMotionRetargetVisibility(createViewer3DMotionRetargetVisibilityState(source?.binding.summary))
    setArtifactPreviewState(createViewer3DArtifactPreviewState())
    setLoadedSource(source)
    const summary = source?.binding.summary
    const rig = createViewer3DRigEditorState(summary)
    const pose = createViewer3DPoseClipState(summary)
    aliasBaseline.current = aliasRevision(rig.renamePlan)
    poseBaseline.current = poseRevision(pose.plan)
    aliasIO.current = null; poseIO.current = null; editIO.current = null
    setRigEditorState(rig); setPoseClipState(pose)
    setSelectedRigTarget(createViewer3DSelectedRigTargetState(summary))
    setRigEditorVisibility(createViewer3DRigEditorVisibilityState(summary))
    setPoseClipVisibility(createViewer3DPoseClipVisibilityState(summary))
    setRigRenameSaveState({ status: 'idle' }); setRigRenameLoadState('idle')
    setRigRenameHydrationWarning(null); setRigMetaHydrationWarning(null)
    setSceneEditMode('idle'); setSaveState({ status: 'idle' }); setEditPlan(null)
    transformHistory.current = []; pendingTransform.current = null
  }, [releaseMotion, releasePose, setLoadedSource, setRigEditorState, setPoseClipState, setMotionRetargetState, setMotionRetargetVisibility])
  useEffect(() => () => { releaseMotion(); releasePose(); motionEpoch.current++ }, [releaseMotion, releasePose])
  useEffect(() => () => setSelected(false), [setSelected])
  // Do not reset child-owned capability reports from a parent mount effect.
  useEffect(() => {
    setSelected(false); setViewMode('solid'); setPlayingUrl(null); setStoreMeshStats(null)
  }, [modelUrl, setSelected, setStoreMeshStats])

  const [semanticMetadata, setSemanticMetadata] = useState<{ source: LoadedScene; context: string; descriptor: Viewer3DKimodoMetadataDescriptor; metadata: Record<string, unknown> } | null>(null)
  const semanticHydrationSource = useMemo(() => {
    const displayed = liveSource?.binding.summary.sourceWorkspacePath
    // Diagnostic source display remains a manual, non-promoting route even
    // when the source filename is not animated.glb. Physical readers still
    // validate source/draft receipts and current Bone bindings independently.
    if (sourceRigFallback && displayed && displayed === sourceRigFallback.result.sourceWorkspacePath) return {
      displayedMeshWorkspacePath: displayed, semanticSourceWorkspacePath: displayed,
      sourceKind: 'kimodo-source' as const, warnings: sourceRigFallback.result.warnings, failedClosed: false,
    }
    return resolveViewer3DSemanticHydrationSource({
      displayedMeshWorkspacePath: displayed, descriptor: kimodoMetadataDescriptor, workspaceDir,
      metadata: semanticMetadata?.source === liveSource && semanticMetadata.context === motionContext && semanticMetadata.descriptor === kimodoMetadataDescriptor ? semanticMetadata.metadata : null,
    })
  }, [liveSource, kimodoMetadataDescriptor, workspaceDir, semanticMetadata, motionContext, sourceRigFallback])
  useEffect(() => {
    const reader = window.electron?.settings?.get
    if (!reader || workspaceDir || !rigEditorVisibility.isOpen) return
    const paths = [checkpoint?.substitutionPoint?.inputArtifact.uri, checkpoint?.substitutionPoint?.inputArtifact.legacy?.filePath]
    const needsRoot = viewerPresentation.modelUrl?.includes('/optimize/serve-file?') || paths.some(path => path && !path.startsWith('/workspace/') && (path.startsWith('/') || /^[A-Za-z]:/.test(path)))
    if (!needsRoot) return
    let cancelled = false
    Promise.resolve().then(() => reader()).then(settings => {
      if (!cancelled && isLive(liveSource) && motionContextRef.current === motionContext && window.electron?.settings?.get === reader) setWorkspaceRoot({ context: motionContext, path: settings.workspaceDir })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [motionContext, rigEditorVisibility.isOpen, workspaceDir, liveSource, isLive])
  const semanticKey = JSON.stringify(semanticHydrationSource)
  const semanticPorts = window.electron?.workspace?.artifacts
  const semanticOwner = useMemo(() => ({ source: liveSource, context: motionContext, key: semanticKey,
    metaReader: semanticPorts?.readRigMetaSidecar, draftReader: semanticPorts?.readHumanoidDraftSidecar,
    promotionReader: semanticPorts?.readHumanoidPromotionSidecar, writer: semanticPorts?.writeHumanoidPromotionSidecar }),
  [liveSource, motionContext, semanticKey, semanticPorts?.readRigMetaSidecar, semanticPorts?.readHumanoidDraftSidecar, semanticPorts?.readHumanoidPromotionSidecar, semanticPorts?.writeHumanoidPromotionSidecar])
  const semanticOwnerRef = useRef(semanticOwner); semanticOwnerRef.current = semanticOwner
  const [humanoidReviewState, humanoidStateRef, setHumanoidReviewState] = useCurrentState(createViewer3DHumanoidReviewState)
  const humanoidLoadedOwner = useRef<typeof semanticOwner | null>(null)
  const humanoidOperation = useRef<object | null>(null)
  const rigPanelEpoch = useRef(0)
  const renderedRigPanelEpoch = rigPanelEpoch.current
  const semanticCurrent = () => {
    const store = useWorkflowRunStore.getState()
    const job = useAppStore.getState().currentJob
    const ports = window.electron?.workspace?.artifacts
    return isLive(semanticOwner.source) && semanticOwnerRef.current === semanticOwner && motionContextRef.current === motionContext
      && store.executionId === executionId && store.activeCheckpointNodeId === checkpointNodeId
      && (!checkpointNodeId || sameCheckpointOwner(checkpoint?.owner, store.getCheckpointOwner(checkpointNodeId)))
      && job?.id === currentJob?.id && job?.outputUrl === currentJob?.outputUrl
      && ports?.readRigMetaSidecar === semanticOwner.metaReader && ports?.readHumanoidDraftSidecar === semanticOwner.draftReader
      && ports?.readHumanoidPromotionSidecar === semanticOwner.promotionReader && ports?.writeHumanoidPromotionSidecar === semanticOwner.writer
  }
  const humanoidCurrent = humanoidLoadedOwner.current === semanticOwner && humanoidReviewState.loadState === 'loaded'
  const humanoidReviewPresentation = resolveViewer3DHumanoidReviewPresentationForHydrationSource({
    presentation: resolveViewer3DHumanoidReviewPresentation({ trustedContractPresent: humanoidCurrent && humanoidReviewState.trustedContractPresent,
      draftResult: humanoidCurrent ? humanoidReviewState.draftResult : undefined, promotionResult: humanoidCurrent ? humanoidReviewState.promotionResult : undefined }),
    semanticHydrationSource,
  })
  const rigDisplayNamingByBoneId = resolveViewer3DEffectiveRigMetaNaming({ summary: liveSource?.binding.summary,
    rigMetaNamingByBoneId: rigEditorState.rigMetaNamingByBoneId,
    draftResult: humanoidCurrent ? humanoidReviewState.draftResult : undefined,
    promotionResult: humanoidCurrent ? humanoidReviewState.promotionResult : undefined })
  useEffect(() => {
    const source = semanticOwner.source
    const summary = source?.binding.summary
    const token = createViewer3DRigMetaHydrationToken({ modelUrl, summary, semanticSourceWorkspacePath: semanticHydrationSource?.semanticSourceWorkspacePath })
    const metaRequest = resolveViewer3DRigMetaHydrationRequest(summary, semanticHydrationSource)
    const request = resolveViewer3DHumanoidHydrationRequest(summary, semanticHydrationSource)
    const previousOwner = humanoidLoadedOwner.current
    humanoidOperation.current = null
    humanoidLoadedOwner.current = semanticOwner
    let cancelled = false
    const current = () => !cancelled && semanticCurrent()
    setHumanoidReviewState(state => ({ ...(previousOwner?.source === source && previousOwner.context === motionContext && previousOwner.key === semanticKey
      ? state : createViewer3DHumanoidReviewState(summary?.sourceWorkspacePath)),
      draftResult: undefined, promotionResult: undefined, trustedContractPresent: false, loadState: 'loading', saveState: { status: 'idle' } }))
    setRigEditorState(state => ({ ...state, rigMetaNamingByBoneId: EMPTY_RIG_META_NAMING }))
    if (!source || !request || !token || !metaRequest) return () => { cancelled = true }
    const metaPromise: Promise<RigMetaSidecarReadResult> = Promise.resolve().then(() => semanticOwner.metaReader
      ? semanticOwner.metaReader(metaRequest) : { success: true as const, status: 'not-found' as const, rigMetaWorkspacePath: metaRequest.sourceWorkspacePath.replace(/\.(glb|gltf)$/i, '.rigmeta.json') })
    metaPromise.then(result => {
      if (!current()) return
      const hydration = applyViewer3DRigMetaHydrationResult({ state: rigStateRef.current, result, token, currentToken: token })
      setRigEditorState(hydration.state); setRigMetaHydrationWarning(hydration.warning)
      setHumanoidReviewState(state => ({ ...state, trustedContractPresent: result.success && result.status === 'found' && !hydration.warning && hasTrustedHumanoidContract(result.rigMeta, summary) }))
    }).catch(error => {
      if (!current()) return
      setRigMetaHydrationWarning({ status: 'warning', messages: [ioError(error, 'Failed to read rig metadata.')] })
    })
    Promise.all([
      Promise.resolve().then(() => semanticOwner.draftReader ? semanticOwner.draftReader(request.draft) : { success: false as const, status: 'error' as const, error: 'Workspace humanoid draft reader is unavailable.' }),
      Promise.resolve().then(() => semanticOwner.promotionReader ? semanticOwner.promotionReader(request.promotion) : { success: false as const, status: 'error' as const, error: 'Workspace humanoid promotion reader is unavailable.' }),
    ]).then(([draftResult, promotionResult]) => {
      if (!current()) return
      const expected = request.draft.meshWorkspacePath
      if (isHumanoidDraftFound(draftResult) && draftResult.sidecar.output.workspacePath !== expected) throw new Error('Humanoid draft output mismatch.')
      if (isHumanoidPromotionFound(promotionResult) && promotionResult.sidecar.output.workspacePath !== expected) throw new Error('Humanoid promotion output mismatch.')
      setHumanoidReviewState(state => applyViewer3DHumanoidHydration({ state, meshWorkspacePath: request.displayedMeshWorkspacePath,
        trustedContractPresent: state.trustedContractPresent, draftResult, promotionResult }))
    }).catch(error => {
      if (!current()) return
      const message = ioError(error, 'Failed to read humanoid sidecars.')
      setHumanoidReviewState(state => ({ ...state, loadState: 'error', draftResult: { success: false, status: 'error', error: message },
        promotionResult: undefined, saveState: { status: 'idle' } }))
    })
    return () => { cancelled = true }
  }, [semanticOwner, setHumanoidReviewState, setRigEditorState])
  const handleSaveHumanoidPromotion = async () => {
    // Check the retained callback's owner BEFORE acquiring or clearing an operation.
    if (!semanticCurrent() || renderedRigPanelEpoch !== rigPanelEpoch.current || !rigEditorVisibility.isOpen
      || humanoidLoadedOwner.current !== semanticOwner || humanoidOperation.current) return
    const state = humanoidStateRef.current
    const writer = semanticOwner.writer
    const audit = resolveViewer3DHumanoidPromotionButtonAudit({ rationale: state.rationale })
    const presentation = resolveViewer3DHumanoidReviewPresentationForHydrationSource({
      presentation: resolveViewer3DHumanoidReviewPresentation(state), semanticHydrationSource })
    const gate = resolveViewer3DHumanoidPromotionGate({ presentation, ...audit, writerAvailable: !!writer })
    if (!gate.allowed || state.loadState !== 'loaded' || !writer || !state.meshWorkspacePath || !isHumanoidDraftFound(state.draftResult) || state.draftResult.status !== 'found') {
      setHumanoidReviewState(current => ({ ...current, saveState: { status: 'error', message: !gate.allowed ? gate.reason : 'No valid humanoid draft is available for promotion.' } })); return
    }
    const revision = JSON.stringify([state.proposedAssignments, state.rationale, state.draftResult])
    const operation = {}; humanoidOperation.current = operation
    const current = () => semanticCurrent() && renderedRigPanelEpoch === rigPanelEpoch.current && humanoidOperation.current === operation
    const request = buildViewer3DHumanoidPromotionWriteRequest({ meshWorkspacePath: state.meshWorkspacePath, draft: state.draftResult.sidecar, sourceSha256: state.draftResult.sourceSha256,
      existingPromotion: isHumanoidPromotionFound(state.promotionResult) ? state.promotionResult.sidecar : undefined,
      proposedAssignments: state.proposedAssignments, rationale: audit.rationale, createdAt: new Date().toISOString(),
      confirmedBy: DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY, confirmedByLabel: DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY_LABEL,
      method: resolveViewer3DHumanoidPromotionMethod({ currentJobId: currentJob?.id, workflowArtifactPresent: !!checkpoint?.substitutionPoint?.inputArtifact }), promotionId: crypto.randomUUID() })
    setHumanoidReviewState(current => ({ ...current, saveState: { status: 'saving' } }))
    try {
      const result = await writer(request)
      if (!current()) return
      const latest = humanoidStateRef.current
      if (JSON.stringify([latest.proposedAssignments, latest.rationale, latest.draftResult]) !== revision) {
        setHumanoidReviewState(state => ({ ...state, saveState: { status: 'idle' } })); return
      }
      setHumanoidReviewState(state => result.success ? { ...state,
        promotionResult: { success: true, status: 'found', sidecarWorkspacePath: result.sidecarWorkspacePath, sidecar: result.sidecar },
        saveState: { status: 'saved', sidecarWorkspacePath: result.sidecarWorkspacePath } }
        : { ...state, promotionResult: undefined, saveState: { status: 'error', message: result.error } })
    } catch (error) {
      if (current()) setHumanoidReviewState(state => ({ ...state, promotionResult: undefined, saveState: { status: 'error', message: ioError(error, 'Promotion could not be saved.') } }))
    } finally { if (humanoidOperation.current === operation) humanoidOperation.current = null }
  }

  // Pose callbacks retain the exact physical IO ports from their render. A
  // replaced bridge cannot complete old work or grant authority to old controls.
  const poseReader = window.electron?.workspace?.artifacts?.readPoseClipSidecar
  const poseWriter = window.electron?.workspace?.artifacts?.writePoseClipSidecar
  const posePortsCurrent = () => window.electron?.workspace?.artifacts?.readPoseClipSidecar === poseReader
    && window.electron?.workspace?.artifacts?.writePoseClipSidecar === poseWriter
  const sourceToken = (source: LoadedScene) => createViewer3DRigHydrationToken({ modelUrl: source.url, summary: source.binding.summary })
  useEffect(() => {
    const source = liveSource
    if (!source) return
    // Retire pending work when this source or its physical pose ports change;
    // keep the authored plan available for a retry through the current bridge.
    poseIO.current = null
    setPoseClipState(state => ({ ...state, saveState: 'idle', loadState: 'idle', saveError: undefined, loadError: undefined }))
    const summary = source.binding.summary
    const token = sourceToken(source)
    const ports = window.electron?.workspace?.artifacts
    const aliasReader = ports?.readRigRenameSidecar
    const poseReader = ports?.readPoseClipSidecar
    const aliasRequest = resolveViewer3DRigHydrationRequest(summary)
    const poseRequest = resolveViewer3DPoseClipHydrationRequest(summary)
    let cancelled = false
    const current = () => !cancelled && isLive(source) && posePortsCurrent()
    if (aliasReader && aliasRequest && token) {
      const operation = {}; aliasIO.current = operation
      const revision = aliasRevision(rigStateRef.current.renamePlan)
      setRigRenameLoadState('loading')
      Promise.resolve().then(() => aliasReader(aliasRequest)).then(result => {
        if (!current() || aliasIO.current !== operation) return
        if (aliasRevision(rigStateRef.current.renamePlan) !== revision) { setRigRenameLoadState('idle'); return }
        const hydration = applyViewer3DRigHydrationResult({ state: rigStateRef.current, result, token, currentToken: token })
        if (!hydration.warning && !hydration.dirtySkipped) aliasBaseline.current = aliasRevision(hydration.state.renamePlan)
        setRigEditorState(hydration.state); setRigRenameHydrationWarning(hydration.warning)
        setRigRenameLoadState(hydration.warning ? 'error' : result.success && result.status === 'found' ? 'loaded' : 'idle')
      }).catch((error: unknown) => {
        if (!current() || aliasIO.current !== operation) return
        if (aliasRevision(rigStateRef.current.renamePlan) !== revision) { setRigRenameLoadState('idle'); return }
        setRigRenameLoadState('error')
        setRigRenameHydrationWarning({ status: 'warning', messages: [ioError(error, 'Failed to read aliases.')] })
      }).finally(() => { if (aliasIO.current === operation) aliasIO.current = null })
    }
    if (poseReader && poseRequest && token) {
      const operation = {}; poseIO.current = operation
      const revision = poseRevision(poseStateRef.current.plan)
      // Reset/close releases preview ownership, not unsaved authoring. A current
      // read may replace the plan/baseline only if authoring was clean at start.
      const dirtyAtStart = revision !== poseBaseline.current
      setPoseClipState(state => ({ ...state, loadState: 'loading' }))
      Promise.resolve().then(() => poseReader(poseRequest)).then(result => {
        if (!current() || poseIO.current !== operation) return
        if (dirtyAtStart || poseRevision(poseStateRef.current.plan) !== revision || poseSessionRef.current) {
          setPoseClipState(state => ({ ...state, loadState: 'idle' })); return
        }
        const hydration = applyViewer3DPoseClipHydrationResult({ state: poseStateRef.current, result, token, currentToken: token })
        if (!hydration.warning) poseBaseline.current = poseRevision(hydration.state.plan)
        setPoseClipState(hydration.state)
      }).catch((error: unknown) => {
        if (current() && poseIO.current === operation) setPoseClipState(state => dirtyAtStart || poseRevision(state.plan) !== revision || poseSessionRef.current ? { ...state, loadState: 'idle' } : { ...state, loadState: 'error', loadError: ioError(error, 'Failed to read pose clip.') })
      }).finally(() => { if (poseIO.current === operation) poseIO.current = null })
    }
    return () => { cancelled = true }
  }, [liveSource, poseReader, poseWriter, isLive, rigStateRef, poseStateRef, setRigEditorState, setPoseClipState])

  type CheckpointAuthority = {
    source: LoadedScene; owner: CheckpointOwner; artifact: ArtifactRef; workspaceDir?: string
    getOwner: (nodeId: string) => CheckpointOwner | undefined
    publish: (owner: CheckpointOwner, artifact: ArtifactRef) => boolean
  }
  const [authority, authorityRef, setAuthority] = useCurrentState<CheckpointAuthority | null>(() => null)
  // Context survives pending validation; only authority grants current capabilities.
  const editContextRef = useRef<Pick<CheckpointAuthority, 'source' | 'owner'> | null>(null)
  useEffect(() => {
    const previous = editContextRef.current
    const source = liveSource
    const store = useWorkflowRunStore.getState()
    const nodeId = checkpointNodeId
    const owner = nodeId ? store.getCheckpointOwner(nodeId) : undefined
    // A revision CAS does not change the source being edited. In particular, our
    // own successful publication must not erase the just-saved plan/status. A
    // different run, checkpoint or input invalidates all outstanding UI work.
    const sameContext = !!previous && previous.source === source && !!owner && modelSource.kind === 'workflow-checkpoint'
      && sameCheckpointOwner({ ...previous.owner, revision: owner.revision }, owner)
    editContextRef.current = null
    setAuthority(null)
    if (!sameContext) {
      editIO.current = null
      setEditPlan(null); setSaveState({ status: 'idle' }); setSceneEditMode('idle')
    }
    const artifact = checkpoint?.substitutionPoint?.inputArtifact
    const path = source?.binding.summary.sourceWorkspacePath
    if (!source || !path || modelSource.kind !== 'workflow-checkpoint' || !owner || !artifact
      || !sameCheckpointOwner(owner, checkpoint?.owner) || artifact.id !== owner.inputArtifactId || artifact.versionId !== owner.inputVersionId) return
    editContextRef.current = { source, owner }
    const capturedArtifact = { ...artifact, legacy: artifact.legacy && { ...artifact.legacy } }
    const getOwner = store.getCheckpointOwner
    const publish = store.setPendingReplacement
    const settingsReader = window.electron?.settings?.get
    let cancelled = false
    const validate = (workspaceDir?: string) => {
      if (cancelled || !isLive(source) || !sameCheckpointOwner(owner, getOwner(owner.nodeId)) || useWorkflowRunStore.getState().activeCheckpointNodeId !== owner.nodeId) return
      const paths = [capturedArtifact.uri, capturedArtifact.legacy?.filePath, checkpoint?.input?.filePath].filter((value): value is string => value !== undefined)
      if (capturedArtifact.kind !== 'mesh' || !paths.length || paths.some(value => artifactWorkspacePath(value, workspaceDir) !== path)) return
      setAuthority({ source, owner, artifact: capturedArtifact, workspaceDir, getOwner, publish })
      setEditPlan(current => sameContext && current ? current : createEditPlan({ sourceArtifactId: artifact.id, sourceVersionId: artifact.versionId, sourceWorkspacePath: path }))
    }
    const paths = [artifact.uri, artifact.legacy?.filePath, checkpoint?.input?.filePath]
    if (paths.some(value => value && (value.startsWith('/') || /^[A-Za-z]:/.test(value)))) {
      if (settingsReader) Promise.resolve().then(() => settingsReader()).then(settings => validate(settings.workspaceDir)).catch(() => undefined)
    } else validate()
    return () => { cancelled = true }
  }, [liveSource, checkpointNodeId, checkpoint?.owner, modelSource.kind, isLive, setAuthority, editContextRef])
  const currentAuthority = authority && isLive(authority.source) && checkpointNodeId === authority.owner.nodeId
    && sameCheckpointOwner(authority.owner, checkpoint?.owner) ? authority : null
  const canShowSceneEditControls = !!currentAuthority && !checkpoint?.landmarkCapture
  const landmarkSession = currentAuthority ? checkpoint?.landmarkCapture : undefined
  const landmarkMarkers = useMemo(() => resolveViewer3DLandmarkMarkers(landmarkSession?.completed), [landmarkSession?.completed])
  const canSaveEditedCopy = !!(canShowSceneEditControls && editPlan?.excludedPartIds.length && saveState.status !== 'saving')
  const selectedPart = sceneParts.find(part => part.id === editPlan?.selectedPartId)
  const hasRigEditorRail = !!liveSource?.binding.summary.hasRig
  const hasPoseClipRail = hasRigEditorRail
  const overlayLayout = resolveViewer3DOverlayLayout({ modelUrl, hasEditRail: canShowSceneEditControls || hasRigEditorRail || hasPoseClipRail, poseClipVisibility, rigEditorVisibility, motionRetargetVisibility })
  const rigTargetState = resolveViewer3DActiveRigTargetState({ rigEditorState, rigEditorVisibility, poseClipState, poseClipVisibility, selectedTarget: selectedRigTarget })
  const rigEditorPanelRenderState = { shouldRenderPanel: !!liveSource && rigEditorVisibility.isOpen }
  const poseClipPanelRenderState = { shouldRenderPanel: !!liveSource && poseClipVisibility.isOpen }
  const rigEffectiveNaming = liveSource?.binding.summary.hasRig ? resolveRigEffectiveNaming(liveSource.binding.summary, rigEditorState.renamePlan, rigDisplayNamingByBoneId) : undefined
  const selectBone = (boneId: RigBoneId) => {
    const source = liveSource
    if (!isLive(source) || !source.binding.bonesById.has(boneId)) return
    setSelectedRigTarget({ skeletonContextId: source.binding.summary.skeletonContextId, selectedBoneId: boneId })
    setRigEditorState(state => ({ ...state, selectedBoneId: boneId }))
    setPoseClipState(state => reduceViewer3DPoseClipState(state, { type: 'select-bone', summary: source.binding.summary, boneId }))
  }
  const rigOverlayProps = resolveViewer3DRigOverlayProps(rigTargetState, { onSelectBone: selectBone }, undefined, rigEffectiveNaming)
  const rigHydrationWarning = rigRenameHydrationWarning && rigMetaHydrationWarning
    ? { status: 'warning' as const, messages: [...rigRenameHydrationWarning.messages, ...rigMetaHydrationWarning.messages] }
    : rigRenameHydrationWarning ?? rigMetaHydrationWarning

  const acquirePose = () => {
    if (motionPreviewRef.current) { releaseMotion(); setMotionRetargetState(state => ({ ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 })) }
    const source = liveSource
    if (!isLive(source) || !posePortsCurrent() || !motionEventCurrent() || !source.binding.summary.hasRig) return null
    if (!poseSessionRef.current) poseSessionRef.current = createPoseClipPreviewSession({ scene: source.scene,
      sourceWorkspacePath: source.binding.summary.sourceWorkspacePath ?? '', skeletonContextId: source.binding.summary.skeletonContextId }, source.binding.bonesById)
    poseOwnerRef.current = source.scene
    setPlayingUrl(null)
    return poseSessionRef.current
  }
  const evaluatePose = (state: Viewer3DPoseClipState, session = poseSessionRef.current) => {
    if (!session || !isLive(liveSource)) return
    evaluatePoseClipPreviewSession(session, { scene: liveSource.scene, sourceWorkspacePath: liveSource.binding.summary.sourceWorkspacePath ?? '',
      skeletonContextId: liveSource.binding.summary.skeletonContextId }, state.plan, state.currentTimeSeconds)
  }
  const authorPose = (action: Viewer3DPoseClipAction, evaluate = true) => {
    if (!isLive(liveSource) || !posePortsCurrent() || !motionEventCurrent()) return
    const session = acquirePose()
    const next = { ...reduceViewer3DPoseClipState(poseStateRef.current, action), previewState: 'paused' as const, saveState: 'idle' as const }
    if (evaluate) evaluatePose(next, session)
    setPoseClipState(next)
  }
  const capturePose = (boneId: RigBoneId, timeSeconds?: number) => {
    if (!isLive(liveSource)) return
    const bone = liveSource.binding.bonesById.get(boneId)
    if (!bone || !acquirePose()) return
    const rotation = { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w }
    authorPose(timeSeconds === undefined ? { type: 'capture-and-advance', summary: liveSource.binding.summary, boneId, rotation }
      : { type: 'capture-keyframe', summary: liveSource.binding.summary, boneId, timeSeconds, rotation }, false)
  }
  const selectedKeyAction = (id: string, action: Viewer3DPoseClipAction) => {
    if (poseStateRef.current.selectedKeyframeId !== id) return
    authorPose(action)
  }
  const handlePoseClipPreviewPlay = () => {
    if (!poseStateRef.current.plan.keyframes.length || !acquirePose()) return
    evaluatePose(poseStateRef.current)
    setPoseClipState(state => ({ ...state, previewState: 'playing' }))
  }
  useEffect(() => {
    const source = liveSource
    const session = poseSessionRef.current
    if (poseClipState.previewState !== 'playing' || !source || !session) return
    const interval = window.setInterval(() => {
      const state = poseStateRef.current
      if (!isLive(source) || poseSessionRef.current !== session || state.previewState !== 'playing') return
      const time = state.currentTimeSeconds >= state.plan.clip.durationSeconds ? 0 : Math.min(state.plan.clip.durationSeconds, state.currentTimeSeconds + 1 / state.plan.clip.fps)
      evaluatePoseClipPreviewSession(session, session.source, state.plan, time)
      setPoseClipState({ ...state, currentTimeSeconds: time })
    }, 1000 / Math.max(1, poseClipState.plan.clip.fps))
    return () => window.clearInterval(interval)
  }, [liveSource, poseClipState.previewState, poseClipState.plan.clip.fps, isLive, poseStateRef, setPoseClipState])

  // Event callbacks belong to this render's epoch; retired callbacks cannot mint a new one.
  const artifactPorts = window.electron?.workspace?.artifacts
  const workspaceArtifactService = useMemo(() => captureViewerWorkspaceArtifactService(),
    [artifactPorts, artifactPorts?.previewWorkspaceArtifact, artifactPorts?.downloadWorkspaceArtifact, artifactPorts?.readSidecar])
  const renderedMotionEpoch = motionEpoch.current
  const motionCurrent = (source: LoadedScene | null, epoch = renderedMotionEpoch, descriptor = kimodoMetadataDescriptor, context = motionContext) => {
    return () => {
      const store = useWorkflowRunStore.getState()
      const job = useAppStore.getState().currentJob
      return isLive(source) && descriptorRef.current === descriptor && motionContextRef.current === context && motionEpoch.current === epoch
        && store.executionId === executionId && store.activeCheckpointNodeId === checkpointNodeId
        && (!checkpointNodeId || sameCheckpointOwner(checkpoint?.owner, store.getCheckpointOwner(checkpointNodeId)))
        && job?.id === currentJob?.id && job?.outputUrl === currentJob?.outputUrl
    }
  }
  const motionEventCurrent = motionCurrent(liveSource)
  const motionPanelCurrent = () => motionEventCurrent() && motionVisibilityRef.current.isOpen
  const presentMotionSession = (session: MotionRetargetSession | undefined, explicitPreview?: MotionRetargetPreviewKind) => {
    if (!session) return session
    if (sourceRigFallback && !selectedMotionModel?.explicit && explicitPreview === undefined) return session
    const presentation = resolveViewer3DMotionRetargetModelPresentation({ defaultModelUrl: modelUrl, apiUrl, session, explicitPreview })
    const path = resolveViewer3DWorkspaceMeshPathFromUrl(presentation.modelUrl, apiUrl, workspaceDir)
    if (!presentation.modelUrl || !path) return session
    const selectedPreview = path === session.artifact.previewGlbWorkspacePath ? 'preview-glb'
      : path === session.artifact.animatedGlbWorkspacePath ? 'animated-glb' : session.selectedPreview
    // Preserve an equivalent serve-file URL; changing spelling alone must not replace its scene.
    const url = path === resolveViewer3DWorkspaceMeshPathFromUrl(modelUrl, apiUrl, workspaceDir) ? modelUrl! : presentation.modelUrl
    setMotionModel({ context: motionContext, url, selectedPreview, explicit: explicitPreview !== undefined })
    return reduceMotionRetargetSession(session, { type: 'set-preview', selectedPreview })
  }
  useEffect(() => {
    releaseMotion()
    motionEpoch.current++; motionIO.current = {}
    setMotionRetargetState(createViewer3DMotionRetargetState(liveSource?.binding.summary))
    setArtifactPreviewState(createViewer3DArtifactPreviewState())
  }, [motionContext, kimodoMetadataDescriptor, liveSource, releaseMotion, setMotionRetargetState])
  useEffect(() => {
    const source = liveSource
    const descriptor = kimodoMetadataDescriptor
    if (!source || !descriptor) return
    const current = motionCurrent(source, motionEpoch.current)
    const reader = globalThis.fetch
    const revision = motionRevision(motionStateRef.current)
    let cancelled = false
    // The no-rig decision belongs to the preview's actual Scene, not the
    // replacement source rig's capability report. Retain that immutable
    // decision through the authorised switch; panel reopen must not oscillate.
    const retained = sourceRigFallback && source.binding.summary.sourceWorkspacePath === sourceRigFallback.result.sourceWorkspacePath
      && !selectedMotionModel?.explicit ? sourceRigFallback : null
    Promise.resolve().then(async () => {
      if (retained) return retained.metadata
      const response = await reader(descriptor.metadataUrl)
      if (!response.ok) throw new Error(`Failed to load Kimodo metadata (${response.status}).`)
      return response.json() as Promise<Record<string, unknown>>
    }).then(async metadata => {
      if (cancelled || !current()) return
      setSemanticMetadata({ source, context: motionContext, descriptor, metadata })
      const state = motionStateRef.current
      if (motionRevision(state) !== revision && state.session) return
      const rig = rigStateRef.current
      const selection = motionModelRef.current?.context === motionContext ? motionModelRef.current : null
      if (!retained && !selection?.explicit) {
        const settingsReader = window.electron?.settings?.get
        if (!workspaceDir && typeof metadata.source_rigged_mesh === 'string' && settingsReader) {
          const settings = await settingsReader()
          if (cancelled || !current() || window.electron?.settings?.get !== settingsReader) return
          if (settings.workspaceDir) {
            setWorkspaceRoot({ context: motionContext, path: settings.workspaceDir })
            return
          }
        }
        const result = resolveViewer3DKimodoSourceRigFallback({ apiUrl, defaultModelUrl: source.url,
          descriptor, metadata, workspaceDir, previewHasUsableRig: source.binding.summary.hasRig })
        if (result.active) {
          setSourceRigDecision({ context: motionContext, descriptor, preview: source, metadata: structuredClone(metadata), result })
          return
        }
      }
      const hydrated = hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({ descriptor, metadata, summary: source.binding.summary,
        previousSession: state.session, selectedPreview: selection?.selectedPreview,
        renamePlan: rig.renamePlan, rigMetaNamingByBoneId: rig.rigMetaNamingByBoneId })
      const session = presentMotionSession(hydrated.session, selection?.explicit ? selection.selectedPreview : undefined)
      const next = reduceViewer3DMotionRetargetState(state, { type: 'set-session', session })
      setMotionRetargetState({ ...next, diagnosticsMessages: hydrated.diagnosticsMessages })
    }).catch((error: unknown) => {
      if (cancelled || !current()) return
      setSemanticMetadata(null)
      // Missing sibling metadata is a nonblocking plain/third-party GLB fallback.
      if (descriptor.detectionMode === 'provenance') setMotionRetargetState(state => ({ ...state,
        diagnosticsMessages: [...state.diagnosticsMessages, ioError(error, 'Kimodo metadata could not be loaded.')] }))
    })
    return () => { cancelled = true }
  }, [liveSource, kimodoMetadataDescriptor, motionContext, motionRetargetVisibility.isOpen, isLive, motionStateRef, rigStateRef, setMotionRetargetState])
  // Display-label changes rebuild the canonical session with its authored mapping snapshot intact.
  useEffect(() => {
    const state = motionStateRef.current
    if (!state.session || !state.summary) return
    const session = createMotionRetargetSession({ targetSummary: state.summary, artifact: state.session.artifact,
      sourceBones: state.session.sourceBones, snapshot: { selectedPreview: state.session.selectedPreview, mappings: state.session.mappings },
      renamePlan: rigEditorState.renamePlan, rigMetaNamingByBoneId: rigEditorState.rigMetaNamingByBoneId })
    setMotionRetargetState({ ...state, session })
  }, [rigEditorState.renamePlan, rigEditorState.rigMetaNamingByBoneId, motionStateRef, setMotionRetargetState])

  const resetMotionUI = () => {
    releaseMotion()
    setMotionRetargetState(state => ({ ...state, previewState: 'idle', previewCurrentTimeSeconds: 0 }))
  }
  const toggleMotion = () => {
    if (!motionEventCurrent() || !isLive(liveSource)) return
    motionEpoch.current++; motionIO.current = {}
    resetMotionUI()
    setArtifactPreviewState(createViewer3DArtifactPreviewState())
    setMotionRetargetState(state => ({ ...state, saveState: 'idle', loadState: 'idle', exportState: 'idle', saveMessage: undefined, loadMessage: undefined, exportMessage: undefined }))
    setMotionRetargetVisibility(current => reduceViewer3DMotionRetargetVisibilityState(current, { type: 'toggle', summary: liveSource.binding.summary }))
  }
  const authorMotion = (action: Viewer3DMotionRetargetAction) => {
    if (!motionPanelCurrent()) return
    const state = reduceViewer3DMotionRetargetState(motionStateRef.current, action)
    setMotionRetargetState({ ...state, saveState: 'idle', saveMessage: undefined, exportState: 'idle', exportMessage: undefined })
    if (motionPreviewRef.current) evaluateMotion(state, state.previewCurrentTimeSeconds)
  }
  const selectMotionPreview = (selectedPreview: MotionRetargetPreviewKind) => {
    if (!motionPanelCurrent()) return
    authorMotion({ type: 'set-preview', selectedPreview })
    motionEpoch.current++; motionIO.current = {}
    resetMotionUI(); handlePoseClipPreviewReset(); setPlayingUrl(null)
    presentMotionSession(motionStateRef.current.session, selectedPreview)
  }
  const beginMotionIO = (kind: keyof typeof motionIO.current, supersede = false) => {
    const current = motionEventCurrent
    if (!motionPanelCurrent() || (!supersede && motionIO.current[kind])) return null
    const operation = {}; motionIO.current[kind] = operation
    const revision = motionRevision(motionStateRef.current)
    return { current: () => current() && motionIO.current[kind] === operation,
      unchanged: () => motionRevision(motionStateRef.current) === revision,
      finish: () => { if (motionIO.current[kind] === operation) delete motionIO.current[kind] } }
  }
  const handleSaveMotionRetargetSidecar = async () => {
    const writer = window.electron?.workspace?.artifacts?.writeMotionRetargetSidecar
    const operation = beginMotionIO('save')
    if (!operation) return
    const state = motionStateRef.current
    setMotionRetargetState(current => ({ ...current, saveState: 'saving', saveMessage: undefined }))
    try {
      if (!writer) throw new Error('Workspace motion retarget writer is unavailable.')
      const result = await writeViewer3DMotionRetargetSidecar({ state, writer })
      if (!operation.current()) return
      setMotionRetargetState(current => !operation.unchanged() ? { ...current, saveState: 'idle' } : result.success
        ? { ...current, saveState: 'saved', saveMessage: `Saved motion retarget sidecar: ${result.sidecarWorkspacePath}`, correctionState: resolveMotionRetargetCorrectionState({ status: 'saved', sidecarWorkspacePath: result.sidecarWorkspacePath }) }
        : { ...current, saveState: 'error', saveMessage: result.error })
    } catch (error) {
      if (operation.current()) setMotionRetargetState(current => ({ ...current, saveState: operation.unchanged() ? 'error' : 'idle', saveMessage: operation.unchanged() ? ioError(error, 'Failed to save corrections.') : undefined }))
    } finally { operation.finish() }
  }
  const loadMotion = async (automatic = false) => {
    const reader = window.electron?.workspace?.artifacts?.readMotionRetargetSidecar
    const state = motionStateRef.current
    const request = resolveViewer3DMotionRetargetHydrationRequest(state.summary, state.session)
    const token = createViewer3DMotionRetargetHydrationToken({ modelUrl, summary: state.summary })
    if (!reader || !request || !token || (automatic && !state.session)) return
    const operation = beginMotionIO('load')
    if (!operation) return
    if (!automatic) resetMotionUI()
    setMotionRetargetState(current => ({ ...current, loadState: 'loading', loadMessage: undefined }))
    try {
      const result = await reader(request)
      if (!operation.current()) return
      if (!operation.unchanged()) { setMotionRetargetState(current => ({ ...current, loadState: 'idle' })); return }
      const hydration = applyViewer3DMotionRetargetHydrationResult({ state: motionStateRef.current, result, token, currentToken: token, showNotFoundMessage: !automatic })
      const next = hydration.dirtySkipped ? { ...hydration.state, loadState: 'idle' as const } : hydration.state
      const session = next.loadState === 'loaded' ? presentMotionSession(next.session) : next.session
      setMotionRetargetState({ ...next, session })
    } catch (error) {
      if (operation.current()) setMotionRetargetState(current => ({ ...current, loadState: operation.unchanged() ? 'error' : 'idle', loadMessage: operation.unchanged() ? ioError(error, 'Failed to load corrections.') : undefined }))
    } finally { operation.finish() }
  }
  useEffect(() => { if (motionRetargetVisibility.isOpen) void loadMotion(true) }, [motionRetargetState.identity?.key, motionRetargetVisibility.isOpen])
  const handleLoadMotionRetargetSidecar = () => loadMotion()
  const handleExportMotionRetargetPoseClipCompanion = async () => {
    const writer = window.electron?.workspace?.artifacts?.writePoseClipSidecar
    const operation = beginMotionIO('export')
    if (!operation) return
    const state = motionStateRef.current
    setMotionRetargetState(current => ({ ...current, exportState: 'exporting', exportMessage: undefined }))
    try {
      if (!writer) throw new Error('Workspace Pose/Clip writer is unavailable.')
      const result = await writeViewer3DMotionRetargetPoseClipCompanion({ state, writer })
      if (operation.current()) setMotionRetargetState(current => !operation.unchanged() ? { ...current, exportState: 'idle' } : result.success
        ? { ...current, exportState: 'exported', exportMessage: `Exported Pose/Clip companion: ${result.sidecarWorkspacePath}` }
        : { ...current, exportState: 'error', exportMessage: result.error })
    } catch (error) {
      if (operation.current()) setMotionRetargetState(current => ({ ...current, exportState: operation.unchanged() ? 'error' : 'idle', exportMessage: operation.unchanged() ? ioError(error, 'Failed to export companion.') : undefined }))
    } finally { operation.finish() }
  }
  const fallbackArtifact = liveSource && sourceRigFallback
    && (liveSource.binding.summary.sourceWorkspacePath === sourceRigFallback.result.sourceWorkspacePath
      || selectedMotionModel?.explicit) ? sourceRigFallback.result.artifact : undefined
  const currentArtifact = (artifact: MotionRetargetArtifactLink) => resolveViewer3DMotionRetargetArtifactEntries(motionStateRef.current.session, fallbackArtifact)
    .find(entry => entry.key === artifact.key && entry.workspacePath === artifact.workspacePath)
  const handleOpenMotionRetargetArtifact = async (artifact: MotionRetargetArtifactLink) => {
    if (!motionPanelCurrent()) return
    const entry = currentArtifact(artifact)
    if (!entry) return
    if (entry.openMode === 'viewer3d-preview') {
      const selectedPreview = entry.key === 'animated-glb' ? 'animated-glb' : 'preview-glb'
      if (motionStateRef.current.session) selectMotionPreview(selectedPreview)
      else {
        const url = resolveViewer3DWorkspaceUrl(apiUrl, entry.workspacePath)
        if (!url) return
        motionEpoch.current++; motionIO.current = {}
        resetMotionUI(); handlePoseClipPreviewReset(); setPlayingUrl(null)
        setMotionModel({ context: motionContext, url, selectedPreview, explicit: true })
      }
      return
    }
    const reader = workspaceArtifactService.previewWorkspaceArtifact
    if (!workspaceArtifactService.isCurrent()) return
    // Supersede only after proving that this callback still owns the panel.
    const operation = beginMotionIO('preview', true)
    if (!operation) return
    try {
      const result = await reader({ workspacePath: entry.workspacePath })
      if (operation.current() && workspaceArtifactService.isCurrent()) setArtifactPreviewState(applyViewer3DMotionRetargetArtifactPreviewResult(entry, result))
    } catch (error) {
      if (operation.current() && workspaceArtifactService.isCurrent()) setArtifactPreviewState(applyViewer3DMotionRetargetArtifactPreviewResult(entry, { success: false, error: ioError(error, 'Artifact preview failed.') }))
    } finally { operation.finish() }
  }
  const handleDownloadMotionRetargetArtifact = async (artifact: MotionRetargetArtifactLink) => {
    const entry = currentArtifact(artifact)
    const downloader = workspaceArtifactService.downloadWorkspaceArtifact
    if (!entry || !workspaceArtifactService.isCurrent()) return
    const operation = beginMotionIO('download')
    if (!operation) return
    try {
      const result = await downloadViewer3DMotionRetargetArtifact({ artifact: entry, downloader })
      if (!result.success && operation.current() && operation.unchanged() && workspaceArtifactService.isCurrent()) setMotionRetargetState(current => ({ ...current, exportState: 'error', exportMessage: result.error }))
    } catch (error) {
      if (operation.current() && operation.unchanged() && workspaceArtifactService.isCurrent()) setMotionRetargetState(current => ({ ...current, exportState: 'error', exportMessage: ioError(error, 'Artifact download failed.') }))
    } finally { operation.finish() }
  }
  const evaluateMotion = (state: Viewer3DMotionRetargetState, time: number) => {
    const owner = motionPreviewRef.current
    const clip = resolveViewer3DMotionRetargetPreviewClip(state)
    if (!owner || !isLive(owner.source) || !clip.available || !clip.plan) return
    restoreThenEvaluateMotionRetargetPreview({ bonesById: owner.bones, snapshot: owner.snapshot, plan: clip.plan,
      timeSeconds: time, summary: state.summary, corrections: state.corrections })
  }
  const acquireMotion = () => {
    const source = liveSource
    const state = motionStateRef.current
    if (!motionPanelCurrent() || !isLive(source) || !resolveViewer3DMotionRetargetPreviewClip(state).available) return false
    if (!motionPreviewRef.current) {
      handlePoseClipPreviewReset()
      const controls = animationControlsRef.current
      if (controls?.scene === source.scene) isolateAnimationForPoseClipPreview(controls.controls.actions, animationPlaying)
      motionPreviewRef.current = { source, bones: new Map(source.binding.bonesById), snapshot: takeMotionRetargetPreviewSnapshot(source.binding.bonesById) }
    }
    poseOwnerRef.current = source.scene
    setPlayingUrl(null)
    return true
  }
  const handlePlayMotionRetargetPreview = () => {
    if (!acquireMotion()) return
    const state = motionStateRef.current
    evaluateMotion(state, state.previewCurrentTimeSeconds)
    setMotionRetargetState({ ...state, previewState: 'playing' })
  }
  const handlePauseMotionRetargetPreview = () => { if (motionPanelCurrent()) setMotionRetargetState(state => ({ ...state, previewState: 'paused' })) }
  const handleResetMotionRetargetPreview = () => {
    if (!motionPanelCurrent()) return
    const controls = animationControlsRef.current
    if (!motionPreviewRef.current && controls && controls.scene === liveSource?.scene && animationPlaying) {
      resetAnimationPlayback(controls.controls); setPlayingUrl(null)
    }
    resetMotionUI()
  }
  const handleScrubMotionRetargetPreview = (timeSeconds: number) => {
    if (!acquireMotion()) return
    const next = reduceViewer3DMotionRetargetState(motionStateRef.current, { type: 'set-preview-time', timeSeconds })
    evaluateMotion(next, next.previewCurrentTimeSeconds)
    setMotionRetargetState({ ...next, previewState: 'paused' })
  }
  const motionClip = resolveViewer3DMotionRetargetPreviewClip(motionRetargetState)
  useEffect(() => {
    const owner = motionPreviewRef.current
    if (!owner || motionRetargetState.previewState !== 'playing') return
    const timer = window.setInterval(() => {
      const state = motionStateRef.current
      const clip = resolveViewer3DMotionRetargetPreviewClip(state)
      if (motionPreviewRef.current !== owner || !isLive(owner.source) || state.previewState !== 'playing' || !clip.plan || !clip.available) return
      const time = state.previewCurrentTimeSeconds >= clip.plan.clip.durationSeconds ? 0 : Math.min(clip.plan.clip.durationSeconds, state.previewCurrentTimeSeconds + 1 / clip.plan.clip.fps)
      restoreThenEvaluateMotionRetargetPreview({ bonesById: owner.bones, snapshot: owner.snapshot, plan: clip.plan, timeSeconds: time, summary: state.summary, corrections: state.corrections })
      setMotionRetargetState({ ...state, previewCurrentTimeSeconds: time })
    }, 1000 / Math.max(1, motionClip.plan?.clip.fps ?? 30))
    return () => window.clearInterval(timer)
  }, [liveSource, motionRetargetState.previewState, motionClip.plan?.clip.fps, isLive, motionStateRef, setMotionRetargetState])
  const handleGlobalPlayback = () => {
    resetMotionUI(); handlePoseClipPreviewReset()
    setPlayingUrl(url => hasAnimations && url !== modelUrl ? modelUrl : null)
  }


  const editAliases = (action: Viewer3DRigEditorAction) => {
    if (!isLive(liveSource)) return
    const next = reduceViewer3DRigEditorState(rigStateRef.current, action)
    next.isRenamePlanDirty = aliasRevision(next.renamePlan) !== aliasBaseline.current
    setRigEditorState(next); setRigRenameSaveState({ status: 'idle' })
  }
  const canSaveAliases = !!(liveSource?.binding.summary.hasRig && rigSourceWorkspacePath && window.electron?.workspace?.artifacts?.writeRigRenameSidecar)
  const aliasesDirty = aliasRevision(rigEditorState.renamePlan) !== aliasBaseline.current
  const canSaveSidecar = !!(liveSource?.binding.summary.hasRig && rigSourceWorkspacePath && poseClipState.plan.keyframes.length && poseRevision(poseClipState.plan) !== poseBaseline.current && window.electron?.workspace?.artifacts?.writePoseClipSidecar)
  const canLoadSidecar = !!(liveSource?.binding.summary.hasRig && rigSourceWorkspacePath && window.electron?.workspace?.artifacts?.readPoseClipSidecar)
  const handleSaveRigAliases = async () => {
    const source = liveSource; const writer = window.electron?.workspace?.artifacts?.writeRigRenameSidecar
    if (!isLive(source) || !writer || !canSaveAliases || !aliasesDirty || aliasIO.current) return
    const state = rigStateRef.current; const revision = aliasRevision(state.renamePlan); const operation = {}
    aliasIO.current = operation; setRigRenameSaveState({ status: 'saving' })
    try {
      const result = await writeViewer3DRigRenameSidecar({ state, writer })
      if (!isLive(source) || aliasIO.current !== operation) return
      if (result.success) {
        aliasBaseline.current = revision
        const dirty = aliasRevision(rigStateRef.current.renamePlan) !== revision
        setRigEditorState(current => ({ ...current, isRenamePlanDirty: dirty }))
        setRigRenameSaveState(dirty ? { status: 'idle' } : { status: 'saved', sidecarWorkspacePath: result.sidecarWorkspacePath })
      } else setRigRenameSaveState(aliasRevision(rigStateRef.current.renamePlan) === revision ? { status: 'error', message: result.error } : { status: 'idle' })
    } catch (error) {
      if (isLive(source) && aliasIO.current === operation) setRigRenameSaveState(aliasRevision(rigStateRef.current.renamePlan) === revision ? { status: 'error', message: ioError(error, 'Failed to save aliases.') } : { status: 'idle' })
    } finally { if (aliasIO.current === operation) aliasIO.current = null }
  }
  const handleSavePoseClipSidecar = async () => {
    const source = liveSource; const writer = window.electron?.workspace?.artifacts?.writePoseClipSidecar
    if (!isLive(source) || !posePortsCurrent() || !motionEventCurrent() || !writer || !canSaveSidecar || poseIO.current) return
    const state = poseStateRef.current; const revision = poseRevision(state.plan); const operation = {}
    poseIO.current = operation; setPoseClipState(current => ({ ...current, saveState: 'saving', saveError: undefined }))
    try {
      const result = await writeViewer3DPoseClipSidecar({ state, writer })
      if (!isLive(source) || !posePortsCurrent() || !motionEventCurrent() || poseIO.current !== operation) return
      if (result.success) poseBaseline.current = revision
      setPoseClipState(current => ({ ...current, saveState: poseRevision(current.plan) !== revision ? 'idle' : result.success ? 'saved' : 'error',
        saveError: !result.success && poseRevision(current.plan) === revision ? result.error : undefined }))
    } catch (error) {
      if (isLive(source) && posePortsCurrent() && motionEventCurrent() && poseIO.current === operation) setPoseClipState(current => ({ ...current,
        saveState: poseRevision(current.plan) === revision ? 'error' : 'idle', saveError: poseRevision(current.plan) === revision ? ioError(error, 'Failed to save pose clip.') : undefined }))
    } finally { if (poseIO.current === operation) poseIO.current = null }
  }
  const handleLoadPoseClipSidecar = async () => {
    const source = liveSource; const reader = window.electron?.workspace?.artifacts?.readPoseClipSidecar
    if (!isLive(source) || !posePortsCurrent() || !motionEventCurrent() || !reader || !canLoadSidecar || poseIO.current) return
    const token = sourceToken(source); const request = resolveViewer3DPoseClipHydrationRequest(source.binding.summary)
    if (!token || !request) return
    const operation = {}; poseIO.current = operation
    handlePoseClipPreviewReset()
    setPoseClipState(state => ({ ...state, loadState: 'loading', loadError: undefined }))
    try {
      const result = await reader(request)
      if (!isLive(source) || !posePortsCurrent() || !motionEventCurrent() || poseIO.current !== operation) return
      // Explicit Load deliberately replaces the authored plan; automatic hydration does not.
      const hydration = applyViewer3DPoseClipHydrationResult({ state: poseStateRef.current, result, token, currentToken: token })
      if (!hydration.warning && result.success && result.status === 'found') poseBaseline.current = poseRevision(hydration.state.plan)
      setPoseClipState({ ...hydration.state, saveState: 'idle', saveError: undefined })
    } catch (error) {
      if (isLive(source) && posePortsCurrent() && motionEventCurrent() && poseIO.current === operation) setPoseClipState(state => ({ ...state, loadState: 'error', loadError: ioError(error, 'Failed to load pose clip.') }))
    } finally { if (poseIO.current === operation) poseIO.current = null }
  }

  const handleSceneSelect = (partId: string | null) => {
    if (canShowSceneEditControls && editPlan && sceneEditMode === 'editing' && partId) {
      if (!editIO.current) setEditPlan(editPlanReducer(editPlan, { type: 'select-part', partId }))
      setSelected(false); onSelectPointLight?.(null)
      return
    }
    setSelected(true); onSelectPointLight?.(null)
  }
  const handleHideSelectedPart = () => {
    if (!editPlan?.selectedPartId || !canShowSceneEditControls || editIO.current) return
    setEditPlan(editPlanReducer(editPlan, { type: 'exclude-selected-part' })); setSaveState({ status: 'idle' })
  }
  const handleResetSceneEdit = () => {
    if (!editPlan || editIO.current) return
    setEditPlan(editPlanReducer(editPlan, { type: 'reset' })); setSaveState({ status: 'idle' })
  }
  const handleClearSceneEdit = () => {
    if (!editPlan || editIO.current) return
    setEditPlan(editPlanReducer(editPlan, { type: 'clear' })); setSaveState({ status: 'idle' })
  }
  const handleSaveEditedCopy = async () => {
    // Every authority is captured BEFORE settings.get, including the exact owner.
    const bound = currentAuthority; const plan = editPlan
    const writer = window.electron?.workspace?.artifacts?.writeEditedSceneArtifact
    const settingsReader = window.electron?.settings?.get
    if (!bound || !plan || !canSaveEditedCopy || !writer || editIO.current) return
    const source = bound.source; const owner = { ...bound.owner }; const getOwner = bound.getOwner; const publish = bound.publish
    const artifact = { ...bound.artifact, legacy: bound.artifact.legacy && { ...bound.artifact.legacy } }
    const operation = {}; editIO.current = operation
    resetMotionUI(); handlePoseClipPreviewReset()
    setSaveState({ status: 'saving' })
    try {
      const exporter = new GLTFExporter()
      const pristine = pristineExportView(source)
      const settings = settingsReader ? await settingsReader() : undefined
      if (!isLive(source) || editIO.current !== operation || authorityRef.current !== bound
        || !sameCheckpointOwner(owner, getOwner(owner.nodeId))) return
      const result = await saveEditedScenePendingReplacement({ ...pristine, parts: source.parts, animationClips: source.animations,
        editPlan: plan, createdAt: new Date().toISOString(), sourceArtifact: artifact, checkpointNodeId: owner.nodeId,
        workspaceDir: settings?.workspaceDir ?? bound.workspaceDir, getCheckpointOwner: () => owner,
        setPendingReplacement: (capturedOwner, replacement) => isLive(source)
          && useWorkflowRunStore.getState().activeCheckpointNodeId === owner.nodeId && publish(capturedOwner, replacement),
        exporter: { parse: (input, done, error, options) => exporter.parse(input, done, error, options) }, writer })
      if (!isLive(source) || editIO.current !== operation) return
      if (result.success) setSaveState(result.status === 'pending-replacement-set'
        ? { status: 'saved', glbWorkspacePath: result.glbWorkspacePath, sidecarWorkspacePath: result.sidecarWorkspacePath }
        : { status: 'saved-unselected', glbWorkspacePath: result.glbWorkspacePath, sidecarWorkspacePath: result.sidecarWorkspacePath })
      else setSaveState({ status: 'error', message: result.error })
    } catch (error) {
      if (isLive(source) && editIO.current === operation) setSaveState({ status: 'error', message: ioError(error, 'Failed to save edited copy.') })
    } finally {
      if (editIO.current === operation) { editIO.current = null; setSaveState(state => state.status === 'saving' ? { status: 'idle' } : state) }
    }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || document.activeElement instanceof HTMLInputElement || !selected) return
      if (viewerPresentation.canDeleteSelectedModel) setCurrentJob(null)
      setSelected(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selected, setCurrentJob, setSelected, viewerPresentation.canDeleteSelectedModel])
  const handlePointerMissed = useCallback(() => { setSelected(false); onSelectPointLight?.(null) }, [setSelected, onSelectPointLight])
  const handleScreenshot = () => {
    const dataUrl = isSplat ? splatRef.current?.screenshot() : canvasRef.current?.toDataURL('image/png')
    if (!dataUrl) return
    const link = document.createElement('a'); link.download = `modly-${Date.now()}.png`; link.href = dataUrl; link.click()
  }
  const handleAnimationAvailability = useCallback((available: boolean) => {
    setAnimationSource({ url: modelUrl, available }); if (!available) setPlayingUrl(null)
  }, [modelUrl])
  const handleRigStats = useCallback((stats: RigStats) => {
    setRigSource({ url: modelUrl, stats }); if (!stats.hasRig) setViewMode(mode => isRigViewMode(mode) ? 'solid' : mode)
  }, [modelUrl])
  // Snapshot the pre-drag pose when a gizmo manipulation starts.
  const handleGizmoDragStart = useCallback(() => {
    if (meshObject) {
      pendingTransform.current = {
        p: meshObject.position.clone(),
        q: meshObject.quaternion.clone(),
        s: meshObject.scale.clone(),
      }
    }
  }, [meshObject])

  // Commit the snapshot on release, but only if the pose actually changed.
  const handleGizmoDragEnd = useCallback(() => {
    const before = pendingTransform.current
    pendingTransform.current = null
    if (!before || !meshObject) return
    const changed = !meshObject.position.equals(before.p)
      || !meshObject.quaternion.equals(before.q)
      || !meshObject.scale.equals(before.s)
    if (changed) transformHistory.current.push(before)
  }, [meshObject])

  // Revert the most recent gizmo manipulation. Returns false when there is
  // nothing to undo, so the caller can fall back to the mesh-history undo.
  const undoTransform = useCallback((): boolean => {
    const prev = transformHistory.current.pop()
    if (!prev || !meshObject) return false
    meshObject.position.copy(prev.p)
    meshObject.quaternion.copy(prev.q)
    meshObject.scale.copy(prev.s)
    return true
  }, [meshObject])

  // Expose transform-undo so the page's Ctrl+Z undoes gizmo edits first.
  useEffect(() => {
    if (!gizmoUndoRef) return
    gizmoUndoRef.current = undoTransform
    return () => { if (gizmoUndoRef.current === undoTransform) gizmoUndoRef.current = null }
  }, [gizmoUndoRef, undoTransform])

  // Drop the transform history when the model changes.
  useEffect(() => {
    transformHistory.current = []
    pendingTransform.current = null
  }, [modelUrl])

  // Memoise the post-processing stack so its children stay referentially stable.
  // @react-three/postprocessing rebuilds (recompiles) all EffectPasses whenever the
  // <EffectComposer> children identity changes; without this, every Viewer3D re-render
  // (e.g. dragging a Lighting slider) recompiles the outline shader. The Outline still
  // tracks selection through the <Selection> context, so nothing here needs to depend
  // on render state.
  const postProcessing = useMemo(() => (
    <EffectComposer
      renderPriority={VIEWER3D_SELECTION_OUTLINE_RENDER_PRIORITY}
      autoClear={false}
      multisampling={SELECTION_OUTLINE_MULTISAMPLING}
      resolutionScale={SELECTION_OUTLINE_RESOLUTION_SCALE}
      frameBufferType={THREE.HalfFloatType}
    >
      <Outline
        blur={SELECTION_OUTLINE_BLUR}
        edgeStrength={SELECTION_OUTLINE_EDGE_STRENGTH}
        visibleEdgeColor={SELECTION_OUTLINE_VISIBLE_COLOR}
        hiddenEdgeColor={SELECTION_OUTLINE_HIDDEN_COLOR}
        xRay={false}
      />
    </EffectComposer>
  ), [])



  return (
    <ModelErrorBoundary resetKey={modelUrl} fallback={<ModelLoadError />}>
      <div className="relative w-full h-full bg-surface-400">
        {!modelUrl && <EmptyState />}

        {/* Splat path → fully isolated viewer (mkkellogg, outside R3F) */}
        {modelUrl && isSplat && splatUrl ? (
          <SplatViewer ref={splatRef} url={splatUrl} autoRotate={autoRotate} />
        ) : null}

        {/* Mesh path → original Canvas, unchanged */}
        {!isSplat && (
        <Canvas
          onPointerMissed={handlePointerMissed}
          camera={{ position: [0, 1.5, 4], fov: 45 }}
          dpr={[1, 2]}
          gl={{
            antialias: true,
            preserveDrawingBuffer: true,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
        >
          <color attach="background" args={['#18181b']} />
          <CanvasCapture domRef={canvasRef} />
          <ambientLight intensity={lightSettings.ambientIntensity ?? DEFAULT_LIGHT_SETTINGS.ambientIntensity} />
          <Environment background={false}>
            <Lightformer intensity={2 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[0, 4, 4]} scale={8} />
            <Lightformer intensity={0.5 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[-4, 2, -4]} scale={6} />
            <Lightformer intensity={0.3 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[4, 1, -4]} scale={6} />
          </Environment>

          <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />

          {modelUrl && currentJob ? (
            <Selection enabled={selected}>
              {postProcessing}
              <Suspense fallback={null}>
                <directionalLight position={[5, 8, 5]} color={lightSettings.mainColor} intensity={lightSettings.mainIntensity} castShadow />
                <directionalLight position={[-4, 2, -4]} color={lightSettings.fillColor} intensity={lightSettings.fillIntensity} />
                <MeshModel
                  key={modelUrl}
                  url={modelUrl}
                  rigSourceWorkspacePath={rigSourceWorkspacePath}
                  viewMode={viewMode}
                  selected={selected}
                  animationPlaying={animationPlaying}
                  onStats={setStoreMeshStats}
                  onSelect={handleSceneSelect}
                  onObject={setMeshObject}
                  onAnimationAvailability={handleAnimationAvailability}
                  onAnimationControlsReady={handleAnimationControls}
                  onRigStats={handleRigStats}
                  poseOwnerRef={poseOwnerRef}
                  editMode={canShowSceneEditControls && sceneEditMode === 'editing'}
                  onSceneReady={handleSceneReady}
                  selectedBoneId={rigTargetState.selectedBoneId}
                  landmarkPicking={landmarkSession && currentAuthority ? {
                    activeLandmarkId: landmarkSession.activeLandmarkId,
                    onPoint: point => {
                      const bound = currentAuthority
                      if (isLive(bound.source)) useWorkflowRunStore.getState().markLandmark(bound.owner, point)
                    },
                  } : undefined}
                />
              </Suspense>
            </Selection>
          ) : null}

          {landmarkSession && currentAuthority && <LandmarkMarkers markers={landmarkMarkers} onSelectLandmark={id => {
            if (isLive(currentAuthority.source)) useWorkflowRunStore.getState().setActiveLandmark(currentAuthority.owner, id)
          }} />}

          {/* Point light markers */}
          {onPointLightsChange && pointLights.map((pl) => (
            <PointLightMarker
              key={pl.id}
              light={pl}
              isSelected={pl.id === selectedPointLightId}
              gizmoMode={gizmoMode}
              onSelect={() => {
                setSelected(false)
                onSelectPointLight?.(pl.id)
              }}
              onPositionChange={(pos) => {
                onPointLightsChange!(pointLights.map((p) => p.id === pl.id ? { ...p, position: pos } : p))
              }}
            />
          ))}

          <SceneFrameController object={currentMeshObject} frameKey={sceneFrameKey} controlsRef={controlsRef} />

          {selected && meshObject && gizmoMode === 'translate' && (
            <TranslateGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}
          {selected && meshObject && gizmoMode === 'rotate' && (
            <RotateGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}
          {selected && meshObject && gizmoMode === 'scale' && (
            <ScaleGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}

          <OrbitControls
            ref={controlsRef}
            makeDefault
            enablePan
            enableZoom
            enableRotate
            minDistance={0.5}
            maxDistance={20}
            autoRotate={autoRotate}
            autoRotateSpeed={1.5}
            enableDamping
            dampingFactor={0.05}
          />

          {canRenderViewportGizmos ? (
            <GizmoHelper alignment="top-right" margin={[72, 72]} renderPriority={viewportGizmoRenderPriority}>
              <GizmoBubbles />
            </GizmoHelper>
          ) : null}
        </Canvas>
        )}

        {viewerPresentation.checkpointLabel && (
          <div className="absolute top-4 left-4 pointer-events-none">
            <span className="rounded-full border border-amber-400/40 bg-amber-950/70 px-3 py-1 text-xs font-medium text-amber-100 shadow-sm">
              {viewerPresentation.checkpointLabel}
            </span>
          </div>
        )}

        {/* Viewer rails — visible only when a model is loaded */}
        {modelUrl && (
          <>
            <ViewerViewToolbar
              viewMode={viewMode}
              autoRotate={autoRotate}
              animationPlaying={animationPlaying}
              hasAnimations={hasAnimations}
              hasRig={hasRig}
              showViewModes={!isSplat}
              onViewMode={setViewMode}
              onAutoRotate={() => setAutoRotate((v) => !v)}
              onAnimationToggle={handleGlobalPlayback}
              onScreenshot={handleScreenshot}
            />
            {!isSplat && liveSource && <ViewerEditToolbar
              sceneEditControls={canShowSceneEditControls && editPlan ? {
                mode: sceneEditMode === 'editing' ? 'editing' : 'available',
                selectedPartLabel: selectedPart?.label,
                excludedCount: editPlan.excludedPartIds.length,
                canSave: canSaveEditedCopy,
                saving: saveState.status === 'saving',
                onEditCheckpoint: () => setSceneEditMode((mode) => mode === 'editing' ? 'idle' : 'editing'),
                onHideSelected: handleHideSelectedPart,
                onReset: handleResetSceneEdit,
                onClear: handleClearSceneEdit,
                onSave: handleSaveEditedCopy,
              } : undefined}
              rigEditorControls={hasRigEditorRail && rigEditorState.summary ? {
                active: Boolean(rigEditorState.summary.hasRig && rigEditorVisibility.isOpen),
                summary: rigEditorState.summary,
                onOpenRigEditor: () => { if (!isLive(liveSource)) return; rigPanelEpoch.current++; humanoidOperation.current = null; setHumanoidReviewState(state => ({ ...state, saveState: { status: 'idle' } })); setRigEditorVisibility((current) => reduceViewer3DRigEditorVisibilityState(current, { type: 'toggle', summary: rigEditorState.summary })) },
              } : undefined}
              poseClipControls={hasPoseClipRail && poseClipState.summary ? {
                active: Boolean(poseClipState.summary.hasRig && poseClipVisibility.isOpen),
                summary: poseClipState.summary,
                onOpenPoseClip: () => { handlePoseClipPreviewReset(); setPoseClipVisibility(current => reduceViewer3DPoseClipVisibilityState(current, { type: 'toggle', summary: poseClipState.summary })) },
              } : undefined}
            />}
          </>
        )}

        {rigEditorPanelRenderState.shouldRenderPanel && (
          <div className={`absolute top-4 ${overlayLayout.editPanelClassName} z-20 w-80 max-w-[calc(100%-5rem)]`}>
            <RigEditorPanel
              {...resolveViewer3DRigEditorPanelProps({ ...rigEditorState, selectedBoneId: rigTargetState.selectedBoneId }, {
                onSelectBone: selectBone,
                onAliasChange: (boneId, alias) => editAliases({ type: 'set-alias', boneId, alias }),
                onCancelAlias: boneId => editAliases({ type: 'cancel-alias', boneId }),
                onRevertAliases: () => editAliases({ type: 'revert-aliases' }),
                onSaveAliases: handleSaveRigAliases,
              }, rigHydrationWarning, { rigMetaNamingByBoneId: rigDisplayNamingByBoneId, humanoidReview: { presentation: humanoidReviewPresentation, saveState: humanoidReviewState.saveState, onPromote: handleSaveHumanoidPromotion } })}
              canSaveAliases={canSaveAliases}
              aliasesDirty={aliasesDirty}
              saveState={rigRenameSaveState.status}
              saveError={rigRenameSaveState.status === 'error' ? rigRenameSaveState.message : undefined}
              loadState={rigRenameLoadState}
              loadError={rigRenameHydrationWarning?.messages.join(' ')}
            />
            {[...authoringPresentation.warnings, ...motionRetargetState.diagnosticsMessages].length > 0 && <p role="status" aria-label="Rig source diagnostics" className="mt-2 text-xs text-amber-100">{[...authoringPresentation.warnings, ...motionRetargetState.diagnosticsMessages].join(' ')}</p>}
            {rigRenameSaveState.status === 'saved' && <p className="mt-2 rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-200">Saved sidecar: {rigRenameSaveState.sidecarWorkspacePath}</p>}
            {rigRenameSaveState.status === 'error' && <p className="mt-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-200">{rigRenameSaveState.message}</p>}
          </div>
        )}

        {artifactPreviewState.status !== 'closed' && (
          <div className="absolute inset-x-4 bottom-4 z-20 mx-auto max-w-3xl rounded-2xl border border-zinc-700/70 bg-zinc-950/95 p-4 text-sm text-zinc-200 shadow-2xl shadow-black/50">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">{artifactPreviewState.title}</p>
                <p className="text-xs text-zinc-400">{artifactPreviewState.displayName}</p>
              </div>
              <button
                type="button"
                onClick={() => { if (motionPanelCurrent()) { delete motionIO.current.preview; setArtifactPreviewState(createViewer3DArtifactPreviewState()) } }}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-200"
              >
                Close preview
              </button>
            </div>
            {artifactPreviewState.status === 'text' ? (
              <>
                <p className="mb-2 text-xs text-zinc-400">{artifactPreviewState.byteLength} bytes{artifactPreviewState.truncated ? ' · preview truncated' : ''}</p>
                <pre className="max-h-[40vh] overflow-auto rounded-xl bg-black/40 p-3 text-xs text-zinc-100">{artifactPreviewState.content}</pre>
              </>
            ) : artifactPreviewState.status === 'audio' ? (
              <div className="space-y-3 rounded-xl bg-black/30 p-3 text-xs text-zinc-200">
                <audio controls preload="metadata" className="w-full" src={artifactPreviewState.sourceUrl}>
                  Your browser does not support audio playback.
                </audio>
                <p className="text-zinc-400">{artifactPreviewState.audioKind.toUpperCase()} · {artifactPreviewState.byteLength} bytes</p>
              </div>
            ) : (
              <div className="space-y-2 rounded-xl bg-black/30 p-3 text-xs text-zinc-200">
                <p>{artifactPreviewState.message}</p>
                <p className="text-zinc-400">{artifactPreviewState.binaryKind.toUpperCase()} · {artifactPreviewState.byteLength} bytes</p>
              </div>
            )}
          </div>
        )}

        {poseClipPanelRenderState.shouldRenderPanel && (
          <div className={`absolute ${overlayLayout.poseClipPanelClassName} z-20 max-w-[calc(100%-5rem)]`}>
            <PoseClipPanel
              {...resolveViewer3DPoseClipPanelProps({ ...poseClipState, selectedBoneId: rigTargetState.selectedBoneId }, {
                onCurrentTimeChange: timeSeconds => authorPose({ type: 'set-current-time', timeSeconds }),
                onClipMetadataChange: metadata => liveSource && authorPose({ type: 'set-clip-metadata', summary: liveSource.binding.summary, ...metadata }),
                onCaptureKeyframe: capturePose,
                onCaptureAndAdvance: boneId => capturePose(boneId),
                onSelectKeyframe: (keyframeId, boneId) => {
                  if (!liveSource || !poseStateRef.current.plan.keyframes.some(key => key.id === keyframeId && key.boneId === boneId)) return
                  selectBone(boneId); authorPose({ type: 'select-keyframe', summary: liveSource.binding.summary, keyframeId })
                },
                onDeleteKeyframe: keyframeId => liveSource && authorPose({ type: 'delete-keyframe', summary: liveSource.binding.summary, keyframeId }),
                onUpdateSelectedKeyframe: (id, boneId) => {
                  const bone = liveSource?.binding.bonesById.get(boneId)
                  if (!liveSource || !bone || !poseStateRef.current.plan.keyframes.some(key => key.id === id && key.boneId === boneId)) return
                  selectedKeyAction(id, { type: 'update-selected-keyframe', summary: liveSource.binding.summary, boneId,
                    rotation: { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w } })
                },
                onDeleteSelectedKeyframe: id => liveSource && selectedKeyAction(id, { type: 'delete-selected-keyframe', summary: liveSource.binding.summary }),
                onMoveSelectedKeyframe: (id, timeSeconds) => liveSource && selectedKeyAction(id, { type: 'move-selected-keyframe', summary: liveSource.binding.summary, timeSeconds }),
                onShiftSelectedKeyframe: (id, deltaSeconds) => liveSource && selectedKeyAction(id, { type: 'shift-selected-keyframe', summary: liveSource.binding.summary, deltaSeconds }),
                onDuplicateSelectedKeyframe: id => liveSource && selectedKeyAction(id, { type: 'duplicate-selected-keyframe', summary: liveSource.binding.summary }),
                onPreviewPlay: handlePoseClipPreviewPlay,
                onPreviewPause: () => { if (posePortsCurrent() && motionEventCurrent()) setPoseClipState(state => ({ ...state, previewState: 'paused' })) },
                onPreviewReset: () => { if (posePortsCurrent() && motionEventCurrent()) handlePoseClipPreviewReset() },
                onRotateSelectedTarget: (boneId, axis, degreesDelta) => {
                  const session = acquirePose()
                  if (!session) return
                  const result = applyLocalPoseClipRotation({ bonesById: session.bonesById, boneId, axis, degreesDelta })
                  if (result.applied) setPoseClipState(state => ({ ...state, previewState: 'paused' }))
                },
                onResetSelectedTarget: boneId => {
                  const session = acquirePose()
                  if (!session) return
                  resetPoseClipSelectedBone({ bonesById: session.bonesById, snapshot: session.snapshot, boneId })
                  setPoseClipState(state => ({ ...state, previewState: 'paused' }))
                },
                onSaveSidecar: handleSavePoseClipSidecar,
                onLoadSidecar: handleLoadPoseClipSidecar,
              }, rigEffectiveNaming)}
              canSaveSidecar={canSaveSidecar}
              canLoadSidecar={canLoadSidecar}
            />
          </div>
        )}

        {modelUrl && rigOverlayProps.overlay && (
          <div className={`absolute ${overlayLayout.rigOverlayClassName} max-w-xs`}>
            <RigOverlay {...rigOverlayProps} />
          </div>
        )}

        {canShowSceneEditControls && sceneEditMode === 'editing' && editPlan && (
          <div className={`absolute top-4 ${overlayLayout.editPanelClassName} z-20 w-72 max-w-[calc(100%-5rem)] rounded-2xl border border-zinc-700/60 bg-zinc-950/85 p-3 text-xs text-zinc-200 shadow-xl backdrop-blur-sm`}>
            <p className="font-medium text-zinc-100">Edit checkpoint</p>
            <p className="mt-1 text-zinc-400">Select a mesh/node, then hide it from the edited copy. This does not delete the checkpoint.</p>
            <div className="mt-3 max-h-40 overflow-auto space-y-1">
              {sceneParts.filter((part) => part.selectable).map((part) => (
                <button
                  key={part.id}
                  type="button"
                  onClick={() => setEditPlan(editPlanReducer(editPlan, { type: 'select-part', partId: part.id }))}
                  className={`block w-full rounded-lg px-2 py-1 text-left ${editPlan.selectedPartId === part.id ? 'bg-violet-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}
                >
                  {part.label}{editPlan.excludedPartIds.includes(part.id) ? ' — excluded' : ''}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!selectedPart || saveState.status === 'saving'} onClick={handleHideSelectedPart} className="rounded-lg bg-zinc-800 px-2 py-1 disabled:opacity-50">Hide from edited copy</button>
              <button type="button" disabled={editPlan.excludedPartIds.length === 0 || saveState.status === 'saving'} onClick={handleResetSceneEdit} className="rounded-lg bg-zinc-800 px-2 py-1 disabled:opacity-50">Reset</button>
              <button type="button" disabled={!canSaveEditedCopy} onClick={handleSaveEditedCopy} className="rounded-lg bg-violet-600 px-2 py-1 text-white disabled:opacity-50">Save edited copy</button>
            </div>
            {saveState.status === 'saved-unselected' && <p className="mt-2 text-amber-300">Saved copy, but the checkpoint changed. The copy was not selected.</p>}
            {saveState.status === 'saved' && <p className="mt-2 text-emerald-300">Saved: {saveState.glbWorkspacePath}</p>}
            {saveState.status === 'error' && <p className="mt-2 text-red-300">{saveState.message}</p>}
          </div>
        )}

        {/* Bottom-left stats overlay */}
        {meshStats && (
          <div className="absolute bottom-4 left-4 pointer-events-none">
            <p className="text-xs text-zinc-500">
              {meshStats.triangles.toLocaleString()} tri &bull; {meshStats.vertices.toLocaleString()} verts
            </p>
          </div>
        )}

        {/* Bottom-right hint */}
        {modelUrl && (
          <div className={`absolute bottom-4 ${overlayLayout.hintClassName} pointer-events-none`}>
            <p className="text-xs text-zinc-600">
              {selected ? viewerPresentation.selectedHint : viewerPresentation.idleHint}
            </p>
          </div>
        )}
      </div>
    </ModelErrorBoundary>
  )
}
