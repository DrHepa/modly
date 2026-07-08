import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Environment, GizmoHelper, Html, Lightformer, OrbitControls, useGizmoContext, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

// Patch THREE pour utiliser BVH sur tous les meshes — réduit le raycast O(N) → O(log N)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast
import SplatViewer, { type SplatViewerHandle } from './SplatViewer'
import { useGeneration } from '@shared/hooks/useGeneration'
import { useAppStore } from '@shared/stores/appStore'
import { ViewerEditToolbar, ViewerViewToolbar, type ViewMode } from './ViewerToolbar'
import type { MotionRetargetArtifactLink } from './MotionRetargetPanel'
import { RigEditorPanel, type RigEditorHumanoidReviewProps } from './RigEditorPanel'
import { RigOverlay } from './RigOverlay'
import { createLandmarkPointIntent, deriveLandmarkMarkers, resolveLandmarkMarkerRenderModels, type LandmarkMarkerViewModel } from './viewerLandmarkPicking'
import { isolateAnimationForPoseClipPreview, resetAnimationPlayback, resolveAnimationAvailability, syncAnimationActions, type AnimationActionLike, type AnimationIsolationSnapshot, type AnimationMixerLike, type AnimationPlaybackResetResult } from './viewerAnimation'
import { PoseClipPanel, type PoseClipDrawerMode, type PoseClipLoadState, type PoseClipPanelWarning, type PoseClipPreviewState, type PoseClipSaveState } from './PoseClipPanel'
import { resolveViewerModelSource } from '../viewerModelSource'
import {
  resolveViewerAssetTarget,
  resolveViewerAssetWorkspacePathFromUrl,
  resolveViewerWorkspacePathFromAbsoluteValue,
  isSafeViewerWorkspaceRelativePath,
  type ViewerAssetTarget,
} from '../viewerAssetTarget.ts'
import { resolveViewerRigSourceWorkspacePath, resolveViewerTargetPresentation } from '../viewerProvenance.ts'
import { downloadWorkspaceArtifact, previewWorkspaceArtifact } from '../viewerWorkspaceArtifactService.ts'
import { collectSceneParts, createEditPlan, editPlanReducer } from '../sceneEdit'
import type { EditPlan, ScenePart } from '../sceneEdit.types'
import { buildRigSelectionOverlay, collectRigSkeletonSummary, type RigBoneId, type RigSelectionOverlayViewModel, type RigSkeletonSummary, type RigSkinnedMeshContext } from '../rigSkeleton.ts'
import { buildRigRenameSidecarV1, createRigRenamePlan, createRigRenameSidecarWorkspacePath, hydrateRigRenamePlanFromSidecar, reduceRigRenamePlan, validateRigRenamePlan, type RigRenamePlan, type RigRenameValidationResult } from '../rigRenamePlan.ts'
import { buildPoseClipSidecarV1, clampPoseClipTime, createLegacyPoseClipSidecarWorkspacePath, createPoseClipCaptureKeyframeId, createPoseClipPlan, createPoseClipSidecarWorkspacePath, deriveKimodoPoseClipCompanionV1, hydratePoseClipPlanFromSidecar, reducePoseClipPlan, validatePoseClipSidecarWorkspacePath, type PoseClipPlan, type PoseClipQuaternion, type PoseClipSidecarV1 } from '../poseClipPlan.ts'
import { applyLocalPoseClipRotation, evaluatePoseClipPreview, resetPoseClipPreview, resetPoseClipSelectedBone, restoreThenEvaluatePoseClipPreview, takePoseClipQuaternionSnapshot, type ApplyLocalPoseClipRotationResult, type EvaluatePoseClipPreviewResult, type PoseClipQuaternionSnapshot, type PoseClipRotationAxis } from '../poseClipPreview.ts'
import { DEFAULT_MOTION_RETARGET_CORRECTIONS, createMotionRetargetCorrectionIdentity, createMotionRetargetSession, createMotionRetargetSidecarV1, hydrateMotionRetargetSessionSnapshotFromSidecar, normalizeMotionRetargetCorrections, reduceMotionRetargetSession, resolveMotionRetargetCorrectionState, type MotionRetargetCorrectionIdentityV1, type MotionRetargetCorrectionsV1, type MotionRetargetMappingEntry, type MotionRetargetPreviewKind, type MotionRetargetSession, type MotionRetargetSourceBone } from '../motionRetargetPlan.ts'
import { normalizeKimodoMotionArtifact, type KimodoMotionArtifact } from '../kimodoMotionAdapter.ts'
import { resolveMotionRetargetPreviewClip, resetMotionRetargetPreview, restoreThenEvaluateMotionRetargetPreview, takeMotionRetargetPreviewSnapshot, type MotionRetargetTransformSnapshot } from '../motionRetargetPreview.ts'
import { resolveRigDisplayNames, type RigDisplayNamingResult } from '../rigDisplayNames.ts'
import { createRigMetaNamingFromHumanoidAssignments, normalizeRigMetaNaming, translateHumanoidAssignmentsToRigMetaNaming, type RigMetaNamingMap } from '../rigMetaNaming.ts'
import { resolveRigEffectiveNaming, type RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'
import {
  saveEditedScenePendingReplacement,
  resolveSceneEditControlsVisibility,
  resolveSceneEditSourceDescriptor,
  resolveScenePartIdForObject,
} from '../sceneEditExportRuntime'
import { useWorkflowRunStore } from '../../workflows/workflowRunStore'
import type { LandmarkId, LandmarkPoint } from '../../workflows/landmarks'
import type { LightSettings } from '../GeneratePage'
import { DEFAULT_LIGHT_SETTINGS } from '../GeneratePage'
import type { HumanoidDraftSidecarReadRequest, HumanoidDraftSidecarReadResult, HumanoidDraftSidecarV1, HumanoidPromotionMethod, HumanoidPromotionSidecarReadRequest, HumanoidPromotionSidecarReadResult, HumanoidPromotionSidecarV1, HumanoidPromotionSidecarWriteRequest, HumanoidPromotionSidecarWriteResult, MotionRetargetSidecarReadRequest, MotionRetargetSidecarReadResult, MotionRetargetSidecarWriteRequest, MotionRetargetSidecarWriteResult, PoseClipSidecarReadRequest, PoseClipSidecarReadResult, PoseClipSidecarWriteRequest, PoseClipSidecarWriteResult, RigMetaSidecarReadRequest, RigMetaSidecarReadResult, RigRenameSidecarReadRequest, RigRenameSidecarReadResult, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult, WorkspaceArtifactDownloadRequest, WorkspaceArtifactDownloadResult, WorkspaceArtifactPreviewRequest, WorkspaceArtifactPreviewResult } from '../../../shared/types/electron.d'
import type { ArtifactRef } from '../../../shared/types/artifacts.ts'

type RigStats = {
  hasRig: boolean
  skinnedMeshCount: number
  boneCount: number
  jointCount: number
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
  tone: RigHelperTone
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

function collectRigSkeletonSummaryFromScene(scene: THREE.Object3D, sourceWorkspacePath?: string): RigSkeletonSummary {
  const skinnedMeshes: RigSkinnedMeshContext[] = []

  scene.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh) || !child.skeleton) return
    skinnedMeshes.push({
      name: child.name,
      path: resolveObjectPath(scene, child),
      skeletonIndex: skinnedMeshes.length,
      skeleton: child.skeleton,
    })
  })

  return collectRigSkeletonSummary({ sourceWorkspacePath, skinnedMeshes })
}

function collectPoseClipBonesByIdFromScene(scene: THREE.Object3D, summary: RigSkeletonSummary): Map<RigBoneId, THREE.Bone> {
  const orderedBones: THREE.Bone[] = []
  const seen = new Set<THREE.Bone>()

  scene.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh) || !child.skeleton) return
    child.skeleton.bones.forEach((bone) => {
      if (seen.has(bone)) return
      seen.add(bone)
      orderedBones.push(bone)
    })
  })

  const bonesById = new Map<RigBoneId, THREE.Bone>()
  summary.bones.forEach((bone, index) => {
    const currentBone = orderedBones[index]
    if (currentBone) bonesById.set(bone.boneId, currentBone)
  })
  return bonesById
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

function ensureInfluenceColors(mesh: THREE.SkinnedMesh, palette: THREE.Color[]): void {
  const geometry = mesh.geometry
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
  ;(material as THREE.MeshStandardMaterial & { skinning: boolean }).skinning = true
  material.toneMapped = true
  return material
}

function createRigShellMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#f8fafc',
    roughness: 0.82,
    metalness: 0.02,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  ;(material as THREE.MeshStandardMaterial & { skinning: boolean }).skinning = true
  return material
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- domRef is a stable ref
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

interface MeshModelProps {
  url: string
  rigSourceWorkspacePath?: string
  viewMode: ViewMode
  animationPlaying: boolean
  onStats: (stats: { vertices: number; triangles: number }) => void
  editMode: boolean
  sceneParts: readonly ScenePart[]
  onSelect: (partId: string | null) => void
  onAnimationAvailability: (hasAnimations: boolean) => void
  onAnimationControlsReady?: (controls: Viewer3DAnimationControls | null) => void
  onRigStats: (stats: RigStats) => void
  onRigSkeletonSummary: (summary: RigSkeletonSummary) => void
  onPoseClipBonesReady?: (bonesById: Map<RigBoneId, THREE.Bone>) => void
  rigSkeletonSummary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  onSceneReady: (scene: THREE.Object3D, parts: ScenePart[]) => void
  landmarkPicking?: {
    activeLandmarkId: LandmarkId
    canvas: HTMLCanvasElement | null
    onPoint: (point: LandmarkPoint) => void
  }
}

function MeshModel({ url, rigSourceWorkspacePath, viewMode, animationPlaying, editMode, sceneParts, onStats, onSelect, onAnimationAvailability, onAnimationControlsReady, onRigStats, onRigSkeletonSummary, onPoseClipBonesReady, rigSkeletonSummary, selectedBoneId, onSceneReady, landmarkPicking }: MeshModelProps): JSX.Element {
  const { scene, animations } = useGLTF(url)
  const captured = useRef(false)
  const edgeHelpers = useRef<THREE.LineSegments[]>([])
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const actionsRef = useRef<THREE.AnimationAction[]>([])
  const rigLineOverlaysRef = useRef<RigLineOverlay[]>([])
  const jointMarkersRef = useRef<JointMarker[]>([])
  const transientMaterialsRef = useRef<THREE.Material[]>([])

  useEffect(() => {
    onAnimationAvailability(resolveAnimationAvailability(animations))
  }, [animations, onAnimationAvailability])

  useEffect(() => {
    const summary = collectRigSkeletonSummaryFromScene(scene, rigSourceWorkspacePath)
    onRigStats({
      hasRig: summary.hasRig,
      skinnedMeshCount: summary.stats.skinnedMeshCount,
      boneCount: summary.stats.boneCount,
      jointCount: summary.stats.boneCount,
    })
    onRigSkeletonSummary(summary)
    onPoseClipBonesReady?.(collectPoseClipBonesByIdFromScene(scene, summary))
  }, [scene, rigSourceWorkspacePath, onRigStats, onRigSkeletonSummary, onPoseClipBonesReady])

  useEffect(() => {
    const animatedNodeNames = animations.flatMap((clip) => clip.tracks.map((track) => track.name.split('.')[0]).filter(Boolean))
    onSceneReady(scene, collectSceneParts(scene, { animatedNodeNames }))
  }, [scene, animations, onSceneReady])

  useEffect(() => {
    const mixer = new THREE.AnimationMixer(scene)
    const actions = animations.map((clip) => mixer.clipAction(clip))
    mixerRef.current = mixer
    actionsRef.current = actions
    onAnimationControlsReady?.({ actions, mixer })

    return () => {
      resetAnimationPlayback({ actions, mixer })
      mixer.stopAllAction()
      mixer.uncacheRoot(scene)
      actionsRef.current = []
      mixerRef.current = null
      onAnimationControlsReady?.(null)
    }
  }, [scene, animations, onAnimationControlsReady])

  useEffect(() => {
    syncAnimationActions(actionsRef.current, animationPlaying && resolveAnimationAvailability(animations))
  }, [animationPlaying, animations])

  useFrame((_, delta) => {
    if (animationPlaying && mixerRef.current) {
      mixerRef.current.update(delta)
    }

    if (rigLineOverlaysRef.current.length > 0 || jointMarkersRef.current.length > 0) {
      const worldPosition = new THREE.Vector3()
      const localPosition = new THREE.Vector3()

      const setBoneLocalPosition = (bone: THREE.Bone, target: THREE.Vector3) => {
        bone.getWorldPosition(worldPosition)
        target.copy(worldPosition)
        scene.worldToLocal(target)
      }

      rigLineOverlaysRef.current.forEach(({ line, segments }) => {
        const position = line.geometry.getAttribute('position') as THREE.BufferAttribute
        segments.forEach(({ parent, child }, index) => {
          setBoneLocalPosition(parent, localPosition)
          position.setXYZ(index * 2, localPosition.x, localPosition.y, localPosition.z)
          setBoneLocalPosition(child, localPosition)
          position.setXYZ(index * 2 + 1, localPosition.x, localPosition.y, localPosition.z)
        })
        position.needsUpdate = true
      })

      jointMarkersRef.current.forEach(({ bone, marker }) => {
        setBoneLocalPosition(bone, localPosition)
        marker.position.copy(localPosition)
      })
    }
  })

  // Expose the scene object so Viewer3D can attach the transform gizmo to it.
  useEffect(() => {
    onObject(scene)
    return () => onObject(null)
  }, [scene, onObject])

  // Free GPU resources and loader cache when this model is replaced or unmounted
  useEffect(() => {
    return () => {
      if (loaderType === 'obj') {
        useLoader.clear(OBJLoader, url)
      } else {
        useGLTF.clear(url)
      }
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach((m: THREE.Material) => m.dispose())
        }
      })
    }
  }, [loaderType, scene, url])

  // Compute BVH on all geometries for fast raycasting (O(log N) vs O(N)).
  // Also force DoubleSide on every material so faces with inverted normals
  // (a known artifact of the flexible-dual-grid mesh decoder) are still visible.
  useEffect(() => {
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        (child.geometry as any).computeBoundsTree()
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
    return () => {
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          (child.geometry as any).disposeBoundsTree?.()
        }
      })
    }
  }, [scene])

  // Centre the mesh on the grid. Runs only on first load / model change — never
  // on plain re-renders, so a live gizmo transform is not silently overwritten.
  useEffect(() => {
    // Clear any cached transform before measuring (useGLTF may reuse a scene
    // that still carries an earlier gizmo pose).
    scene.position.set(0, 0, 0)
    scene.rotation.set(0, 0, 0)
    scene.scale.set(1, 1, 1)
    const box = new THREE.Box3().setFromObject(scene)
    const center = new THREE.Vector3()
    box.getCenter(center)
    scene.position.set(-center.x, -box.min.y, -center.z)

    // Compute stats
    let vertices = 0
    let triangles = 0
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        vertices += child.geometry.attributes.position?.count ?? 0
        triangles += child.geometry.index
          ? child.geometry.index.count / 3
          : (child.geometry.attributes.position?.count ?? 0) / 3
      }
    })
    const roundedTriangles = Math.round(triangles)
    onStats({ vertices: Math.round(vertices), triangles: roundedTriangles })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute on scene change only; onStats is a stable callback
  }, [scene])

  // Thumbnail capture (kept for future use)
  useEffect(() => {
    captured.current = false
  }, [url])

  // Material swapping based on viewMode
  useEffect(() => {
    // Remove any edge helpers from previous wireframe pass
    edgeHelpers.current.forEach((lines) => lines.parent?.remove(lines))
    edgeHelpers.current = []
    rigLineOverlaysRef.current.forEach(({ line }) => {
      line.parent?.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    })
    rigLineOverlaysRef.current = []
    jointMarkersRef.current.forEach(({ marker }) => {
      marker.parent?.remove(marker)
      marker.geometry.dispose()
      ;(marker.material as THREE.Material).dispose()
    })
    jointMarkersRef.current = []
    transientMaterialsRef.current.forEach((material) => material.dispose())
    transientMaterialsRef.current = []

    const trackMaterial = <T extends THREE.Material>(material: T): T => {
      transientMaterialsRef.current.push(material)
      return material
    }

    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      // Save original material on first visit
      if (!child.userData.originalMaterial) {
        child.userData.originalMaterial = child.material
      }

      let next: THREE.Material
      switch (viewMode) {
        case 'bones':
        case 'joints':
          next = trackMaterial(createRigShellMaterial())
          break
        case 'influence':
          if (child instanceof THREE.SkinnedMesh && child.skeleton) {
            ensureInfluenceColors(child, buildInfluencePalette(child.skeleton.bones.length))
            next = trackMaterial(createInfluenceMaterial())
          } else {
            next = trackMaterial(createMutedRigBackdropMaterial())
          }
          break
        case 'wireframe': {
          next = trackMaterial(new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true }))
          break
        }
        case 'normals':
          // Ensure vertex normals exist — AI-generated meshes often skip this
          child.geometry.computeVertexNormals()
          next = trackMaterial(new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }))
          break
        case 'matcap':
          next = trackMaterial(new THREE.MeshMatcapMaterial({ matcap: createMatcapTexture() }))
          break
        case 'uv':
          next = trackMaterial(new THREE.MeshBasicMaterial({ map: createCheckerTexture() }))
          break
        default:
          next = child.userData.originalMaterial as THREE.Material
      }

      child.material = next
    })

    if (isRigViewMode(viewMode)) {
      const bones = new Set<THREE.Bone>()
      const orderedBones: THREE.Bone[] = []

      scene.traverse((child) => {
        if (!(child instanceof THREE.SkinnedMesh) || !child.skeleton) return
        child.skeleton.bones.forEach((bone) => {
          if (bones.has(bone)) return
          bones.add(bone)
          orderedBones.push(bone)
        })
      })

      const boneIdsByBone = new Map<THREE.Bone, RigBoneId>()
      orderedBones.forEach((bone, index) => {
        const boneId = rigSkeletonSummary?.bones[index]?.boneId
        if (boneId) boneIdsByBone.set(bone, boneId)
      })
      const helperStyles = resolveViewer3DRigHelperStyles(rigSkeletonSummary, selectedBoneId)

      const segments = Array.from(bones)
        .filter((bone) => bone.parent instanceof THREE.Bone && bones.has(bone.parent))
        .map((bone) => ({ parent: bone.parent as THREE.Bone, child: bone, childBoneId: boneIdsByBone.get(bone) }))

      if (segments.length > 0) {
        const selectedSegments = segments.filter((segment) => segment.childBoneId && helperStyles.segmentStylesByChildBoneId[segment.childBoneId]?.tone === 'selected')
        const defaultSegments = segments.filter((segment) => !selectedSegments.includes(segment))

        const addLineOverlay = (lineSegments: BoneSegment[], style: RigHelperSegmentStyle) => {
          if (lineSegments.length === 0) return
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineSegments.length * 2 * 3), 3))
          const material = new THREE.LineBasicMaterial({
            color: viewMode === 'influence' && style.tone === 'default' ? '#f8fafc' : style.color,
            transparent: true,
            opacity: viewMode === 'influence' && style.tone === 'default' ? 0.72 : style.opacity,
            depthTest: false,
            depthWrite: false,
          })
          const line = new THREE.LineSegments(geometry, material)
          line.frustumCulled = false
          line.renderOrder = style.renderOrder
          scene.add(line)
          rigLineOverlaysRef.current.push({ line, segments: lineSegments, tone: style.tone })
        }

        addLineOverlay(defaultSegments, DEFAULT_RIG_HELPER_SEGMENT_STYLE)
        addLineOverlay(selectedSegments, SELECTED_RIG_HELPER_SEGMENT_STYLE)
      }

      if (viewMode === 'joints' || viewMode === 'influence') {
        bones.forEach((bone) => {
          const boneId = boneIdsByBone.get(bone)
          const markerStyle = boneId ? helperStyles.markerStylesByBoneId[boneId] ?? DEFAULT_RIG_HELPER_MARKER_STYLE : DEFAULT_RIG_HELPER_MARKER_STYLE
          const marker = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.026, 0),
            new THREE.MeshStandardMaterial({ color: markerStyle.color, emissive: markerStyle.emissive, emissiveIntensity: markerStyle.emissiveIntensity, roughness: 0.35, metalness: 0.08, depthTest: false, depthWrite: false }),
          )
          marker.frustumCulled = false
          marker.renderOrder = markerStyle.renderOrder
          marker.scale.setScalar(markerStyle.scale)
          scene.add(marker)
          jointMarkersRef.current.push({ bone, boneId, marker })
        })
      }
    }
  }, [scene, viewMode, rigSkeletonSummary, selectedBoneId])

  return (
    <primitive
      object={scene}
      onClick={(e: MeshModelClickEvent) => {
        e.stopPropagation()
        if (landmarkPicking?.canvas) {
          const sourceEvent = e.nativeEvent
          const intersections = e.intersections.length > 0
            ? e.intersections.map((intersection) => ({ object: intersection.object, point: intersection.point }))
            : [{ object: e.object, point: e.point }]
          const intent = createLandmarkPointIntent({
            activeLandmarkId: landmarkPicking.activeLandmarkId,
            pointer: { clientX: sourceEvent.clientX, clientY: sourceEvent.clientY },
            canvas: landmarkPicking.canvas,
            intersections,
            clickableObjects: [scene],
          })
          if (intent) landmarkPicking.onPoint(intent.point)
          return
        }
        if (!editMode) {
          onSelect(null)
          return
        }
        onSelect(resolveScenePartIdForObject({ scene, target: e.object, parts: sceneParts }))
      }}
    />
  )

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
  | { status: 'saved'; glbWorkspacePath: string; sidecarWorkspacePath: string }
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

const DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY = 'modly:user:local:drhepa'
const DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY_LABEL = 'drhepa'
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
    selectedBoneId: summary.hasRig ? (summary.rootBoneIds[0] ?? summary.bones[0]?.boneId) : undefined,
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
    selectedBoneId: summary?.hasRig ? (summary.rootBoneIds[0] ?? summary.bones[0]?.boneId) : undefined,
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
  const localSession = cloneViewer3DMotionRetargetSession(session)
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
        : action.summary?.rootBoneIds[0] ?? action.summary?.bones[0]?.boneId
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
      const session = cloneViewer3DMotionRetargetSession(action.session)
      const identity = createViewer3DMotionRetargetCorrectionIdentity({ summary: state.summary, session })
      return {
        ...state,
        session,
        identity,
        corrections: state.corrections,
        correctionState: state.correctionState.status === 'loaded' ? state.correctionState : resolveMotionRetargetCorrectionState({ status: 'idle' }),
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
  const selectedSourceBoneId = state.selectedSourceBoneId ?? state.session?.sourceBones[0]?.sourceBoneId
  const preview = resolveViewer3DMotionRetargetPreviewClip(state)
  return {
    summary: state.summary,
    session: state.session,
    selectedSourceBoneId,
    selectedMapping: selectedSourceBoneId ? state.session?.mappings[selectedSourceBoneId] : undefined,
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

export function resolveViewer3DKimodoMetadataDescriptor(args: {
  apiUrl: string
  artifact?: ArtifactRef
  modelUrl?: string | null
}): Viewer3DKimodoMetadataDescriptor | undefined {
  const artifact = args.artifact ?? createViewer3DKimodoFallbackArtifactFromModelUrl(args.modelUrl)
  if (!artifact) return undefined

  const detectionMode = artifact.provenance?.extensionId === 'kimodo-soma-rp' && artifact.provenance.extensionNodeId === 'animate-rigged-mesh'
    ? 'provenance'
    : !artifact.provenance && resolveViewer3DArtifactWorkspacePath(artifact, args.modelUrl)?.endsWith('.glb')
      ? 'sibling-metadata'
      : undefined
  if (!detectionMode) return undefined

  const artifactWorkspacePath = resolveViewer3DArtifactWorkspacePath(artifact, args.modelUrl)
  if (!artifactWorkspacePath) return undefined

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

function resolveViewer3DArtifactWorkspacePath(artifact: ArtifactRef, modelUrl: string | null | undefined): string | undefined {
  return normalizeViewer3DWorkspacePath(artifact.legacy?.filePath)
    ?? normalizeViewer3DWorkspacePath(artifact.uri)
    ?? resolveViewerAssetWorkspacePathFromUrl(modelUrl)
}

function createViewer3DKimodoFallbackArtifactFromModelUrl(modelUrl: string | null | undefined): ArtifactRef | undefined {
  const artifactWorkspacePath = resolveViewerAssetWorkspacePathFromUrl(modelUrl)
  if (!artifactWorkspacePath) return undefined

  const artifactUri = `/workspace/${artifactWorkspacePath}`
  const artifactId = `viewer3d:model-url:${artifactWorkspacePath}`

  return {
    id: artifactId,
    kind: 'mesh',
    uri: artifactUri,
    versionId: artifactId,
    legacy: {
      filePath: artifactUri,
      outputType: 'mesh',
    },
  }
}

export function hydrateViewer3DMotionRetargetSessionFromKimodoMetadata(args: {
  descriptor?: Viewer3DKimodoMetadataDescriptor
  metadata: Record<string, unknown>
  summary?: RigSkeletonSummary
  previousSession?: MotionRetargetSession
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
    artifact: args.descriptor.artifact,
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
            path: sourceBone.parentSourceBoneId ? [sourceBone.parentSourceBoneId, sourceBone.label] : [sourceBone.label],
            ...(sourceBone.parentSourceBoneId ? { parentSourceBoneId: sourceBone.parentSourceBoneId } : {}),
          }))
        : deriveKimodoSourceBones(args.metadata))
    : []
  const diagnosticsMessages = dedupeViewer3DWarnings([
    ...(normalized.artifact.motionRetarget ? [] : ['Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.']),
    ...(sourceBones.length === 0 ? ['Diagnostics-only inspection is available until Kimodo exports source bone metadata.'] : []),
    ...(!isKimodoAnimatedGlbSafeForPreview(normalized.artifact) && normalized.artifact.previewGlbWorkspacePath && normalized.artifact.animatedGlbWorkspacePath
      ? ['Animated GLB fallback engaged because Kimodo reported degraded retarget diagnostics.']
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
        selectedPreview: args.previousSession?.selectedPreview
          ?? (isKimodoAnimatedGlbSafeForPreview(normalized.artifact) ? 'animated-glb' : 'preview-glb'),
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
}): {
  modelUrl: string | null
  warnings: string[]
} {
  const warnings = dedupeViewer3DWarnings([...(args.diagnosticsMessages ?? []), ...(args.session?.warnings ?? [])])
  if (!args.session) {
    return { modelUrl: args.defaultModelUrl, warnings }
  }

  const previewUrl = resolveViewer3DWorkspaceUrl(args.apiUrl, args.session.artifact.previewGlbWorkspacePath)
  const animatedUrl = isKimodoAnimatedGlbSafeForPreview(args.session.artifact)
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
  if (!normalized) return undefined
  const workspacePath = normalized.includes('/') ? normalized : `${bundleWorkspacePath}/${normalized}`
  return normalizeViewer3DWorkspacePath(workspacePath)
}

function resolveViewer3DKimodoFallbackSourceWorkspacePath(metadata: Record<string, unknown>): string | undefined {
  if (Object.prototype.hasOwnProperty.call(metadata, 'source_workspace_path')) {
    const normalized = normalizeViewer3DWorkspacePath(readViewer3DMetadataString(metadata, 'source_workspace_path'))
    return normalized && isSafeViewerWorkspaceRelativePath(normalized, { meshOnly: true }) ? normalized : undefined
  }
  return resolveViewerWorkspacePathFromAbsoluteValue(readViewer3DMetadataString(metadata, 'source_rigged_mesh') ?? '', { meshOnly: true })
}

function isViewer3DKimodoPreviewOnlyDegradedArtifact(artifact: KimodoMotionArtifact, previewHasUsableRig: boolean): boolean {
  if (previewHasUsableRig) return false
  if (!artifact.previewGlbWorkspacePath) return false
  if (isKimodoAnimatedGlbSafeForPreview(artifact)) return false

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
      runtimeStatus,
      retargetStatus,
      animationMappingStatus,
      stabilizationStatus: readViewer3DMetadataString(args.metadata, 'stabilization_status'),
      visualQualityStatus,
      sourceKind: readViewer3DMetadataString(args.metadata, 'source_kind'),
      mappingConfidence: readViewer3DMetadataString(args.metadata, 'mapping_confidence'),
      retargetErrorCode: readViewer3DMetadataString(args.metadata, 'retarget_error_code') ?? null,
      retargetErrorAliases: [],
      retargetErrorMessage: readViewer3DMetadataString(args.metadata, 'retarget_error_message') ?? null,
      warnings,
      raw: rawMetadata,
    },
    warnings,
  }
}

export function resolveViewer3DKimodoSourceRigFallback(args: {
  apiUrl: string
  defaultModelUrl: string | null
  descriptor?: Viewer3DKimodoMetadataDescriptor
  metadata?: Record<string, unknown> | null
  previewHasUsableRig: boolean
}): Viewer3DKimodoSourceRigFallbackResult {
  const inactive = (artifact?: KimodoMotionArtifact, warnings: string[] = []): Viewer3DKimodoSourceRigFallbackResult => ({
    active: false,
    modelUrl: args.defaultModelUrl,
    warnings,
    ...(artifact ? { artifact } : {}),
  })

  if (!args.descriptor || !args.metadata) return inactive()

  const sourceWorkspacePath = resolveViewer3DKimodoFallbackSourceWorkspacePath(args.metadata)
  const artifact = createViewer3DKimodoFallbackArtifact({ descriptor: args.descriptor, metadata: args.metadata, sourceWorkspacePath })
  const fallbackWarnings = dedupeViewer3DWarnings([VIEWER3D_KIMODO_SOURCE_RIG_FALLBACK_WARNING, ...artifact.warnings])

  if (!isViewer3DKimodoPreviewOnlyDegradedArtifact(artifact, args.previewHasUsableRig) || !sourceWorkspacePath) {
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

function isKimodoAnimatedGlbSafeForPreview(artifact: KimodoMotionArtifact): boolean {
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
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/workspace\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || /%2e|%2f|%5c/i.test(normalized)) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) return undefined
  return segments.join('/')
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

function normalizeViewer3DSemanticSourceFromAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return resolveViewerWorkspacePathFromAbsoluteValue(value, { meshOnly: true })
}

export function resolveViewer3DSemanticHydrationSource(args: {
  displayedMeshWorkspacePath?: string
  descriptor?: Viewer3DKimodoMetadataDescriptor
  metadata?: Record<string, unknown> | null
}): Viewer3DSemanticHydrationSource | undefined {
  const fallback = createViewer3DDisplayedSemanticHydrationSource(args.displayedMeshWorkspacePath)
  if (!fallback) return undefined
  if (!args.descriptor || !args.metadata) return fallback

  const displayedFilename = fallback.displayedMeshWorkspacePath.split('/').filter(Boolean).at(-1)?.toLowerCase()
  if (displayedFilename !== 'animated.glb') return fallback

  const semanticSourceWorkspacePath = normalizeViewer3DSemanticWorkspaceSourcePath(args.metadata.source_workspace_path)
    ?? normalizeViewer3DSemanticSourceFromAbsolutePath(args.metadata.source_rigged_mesh)

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

  if (isHumanoidPromotionFound(promotionResult) && promotionResult.status === 'found') {
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
  const shouldResetProposal = !state.isProposalDirty || state.meshWorkspacePath !== meshWorkspacePath || state.proposalSourceDraftSha256 !== currentDraftSha256

  return {
    ...state,
    meshWorkspacePath,
    trustedContractPresent,
    draftResult,
    promotionResult,
    proposedAssignments: shouldResetProposal && isHumanoidDraftFound(draftResult)
      ? createViewer3DHumanoidProposedAssignments(draftResult.sidecar)
      : shouldResetProposal
        ? structuredClone(EMPTY_HUMANOID_ASSIGNMENTS)
        : state.proposedAssignments,
    proposalSourceDraftSha256: currentDraftSha256,
    isProposalDirty: shouldResetProposal ? false : state.isProposalDirty,
    rationale: shouldResetProposal ? DEFAULT_VIEWER3D_HUMANOID_PROMOTION_RATIONALE : state.rationale,
    confirmationChecked: shouldResetProposal ? true : state.confirmationChecked,
    loadState: 'loaded',
    saveState: state.saveState.status === 'saved' ? state.saveState : { status: 'idle' },
  }
}

function hasTrustedHumanoidContractNaming(rigMetaNamingByBoneId: RigMetaNamingMap): boolean {
  return Object.values(rigMetaNamingByBoneId).some((entry) => entry.source === 'humanoid_contract')
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
  if (!state.summary?.hasRig || !state.summary.sourceWorkspacePath) return 'Save requires a source-backed rig.'
  if (!state.session) return 'Save requires a loaded Kimodo motion session.'
  if (!state.session.unlockReadiness.canSaveSidecar || !state.session.exportReadiness.canSaveSidecar) return MOTION_RETARGET_SAVE_UNAVAILABLE
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

function cloneViewer3DMotionRetargetSession(session?: MotionRetargetSession): MotionRetargetSession | undefined {
  return session ? structuredClone(session) : undefined
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
  if (!summary?.hasRig || !summary.sourceWorkspacePath || !validation.valid || Object.keys(state.renamePlan.aliases).length === 0) {
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
    sidecarWorkspacePath: createViewer3DMotionRetargetSidecarWorkspacePath(summary.sourceWorkspacePath, session),
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
    summary: state.summary,
  })
  const warning = normalized.warnings.length > 0 ? { status: 'warning' as const, messages: normalized.warnings } : null

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
    sidecarWorkspacePath: createViewer3DMotionRetargetSidecarWorkspacePath(sourceWorkspacePath, session),
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
      state: { ...state, diagnosticsMessages: hydrated.warnings, loadState: 'error', loadMessage: message, correctionState: resolveMotionRetargetCorrectionState({ status: 'error', message }) },
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
  return summary.rootBoneIds[0] ?? summary.bones[0]?.boneId
}

function resolveValidRigSelectedBoneId(summary: RigSkeletonSummary | undefined, selectedBoneId: RigBoneId | undefined): RigBoneId | undefined {
  if (!summary?.hasRig) return undefined
  return selectedBoneId && summary.bones.some((bone) => bone.boneId === selectedBoneId)
    ? selectedBoneId
    : resolveDefaultRigSelectedBoneId(summary)
}

export function resolveViewer3DPresentation(target: ViewerAssetTarget): Viewer3DPresentation {
  return resolveViewerTargetPresentation(target)
}

export function resolveViewer3DRigSourceWorkspacePath(target: Pick<ViewerAssetTarget, 'workspacePath' | 'modelUrl'>): string | undefined {
  return resolveViewerRigSourceWorkspacePath(target)
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

export default function Viewer3D({ lightSettings = DEFAULT_LIGHT_SETTINGS }: { lightSettings?: LightSettings }): JSX.Element {
  const { currentJob } = useGeneration()
  const apiUrl = useAppStore((s) => s.apiUrl)

  const setStoreMeshStats = useAppStore((s) => s.setMeshStats)
  const meshStats = useAppStore((s) => s.meshStats)
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)
  const workflowRunState = useWorkflowRunStore((s) => s.runState)
  const setPendingReplacement = useWorkflowRunStore((s) => s.setPendingReplacement)
  const landmarkSession = useWorkflowRunStore((s) => s.landmarkSession)
  const markLandmark = useWorkflowRunStore((s) => s.markLandmark)
  const selectLandmarkForEditing = useWorkflowRunStore((s) => s.selectLandmarkForEditing)

  const [viewMode, setViewMode] = useState<ViewMode>('solid')
  const [autoRotate, setAutoRotate] = useState(false)
  const [animationPlaying, setAnimationPlaying] = useState(false)
  const [hasAnimations, setHasAnimations] = useState(false)
  const [rigStats, setRigStats] = useState<RigStats>({ hasRig: false, skinnedMeshCount: 0, boneCount: 0, jointCount: 0 })
  const [rigEditorState, setRigEditorState] = useState<Viewer3DRigEditorState>(() => createViewer3DRigEditorState())
  const [rigEditorVisibility, setRigEditorVisibility] = useState<Viewer3DRigEditorVisibilityState>(() => createViewer3DRigEditorVisibilityState())
  const [poseClipState, setPoseClipState] = useState<Viewer3DPoseClipState>(() => createViewer3DPoseClipState())
  const [poseClipVisibility, setPoseClipVisibility] = useState<Viewer3DPoseClipVisibilityState>(() => createViewer3DPoseClipVisibilityState())
  const [motionRetargetState, setMotionRetargetState] = useState<Viewer3DMotionRetargetState>(() => createViewer3DMotionRetargetState())
  const [motionRetargetVisibility, setMotionRetargetVisibility] = useState<Viewer3DMotionRetargetVisibilityState>(() => createViewer3DMotionRetargetVisibilityState())
  const [selectedRigTarget, setSelectedRigTarget] = useState<Viewer3DSelectedRigTargetState>(() => createViewer3DSelectedRigTargetState())
  const [selected, setSelected] = useState(false)
  const [sceneEditMode, setSceneEditMode] = useState<'idle' | 'editing'>('idle')
  const [sceneParts, setSceneParts] = useState<ScenePart[]>([])
  const [editPlan, setEditPlan] = useState<EditPlan | null>(null)
  const [saveState, setSaveState] = useState<SceneEditSaveState>({ status: 'idle' })
  const [rigRenameSaveState, setRigRenameSaveState] = useState<RigRenameSaveState>({ status: 'idle' })
  const [rigRenameHydrationWarning, setRigRenameHydrationWarning] = useState<Viewer3DRigHydrationWarning | null>(null)
  const [rigMetaHydrationWarning, setRigMetaHydrationWarning] = useState<Viewer3DRigHydrationWarning | null>(null)
  const [humanoidReviewState, setHumanoidReviewState] = useState<Viewer3DHumanoidReviewState>(() => createViewer3DHumanoidReviewState())
  const [kimodoMetadata, setKimodoMetadata] = useState<Record<string, unknown> | null>(null)
  const [artifactPreviewState, setArtifactPreviewState] = useState<Viewer3DArtifactPreviewState>(() => createViewer3DArtifactPreviewState())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sceneRef = useRef<THREE.Object3D | null>(null)
  const poseClipBonesRef = useRef<Map<RigBoneId, THREE.Bone>>(new Map())
  const poseClipSnapshotRef = useRef<PoseClipQuaternionSnapshot | null>(null)
  const motionRetargetSnapshotRef = useRef<MotionRetargetTransformSnapshot | null>(null)
  const motionRetargetWasOpenRef = useRef(motionRetargetVisibility.isOpen)
  const animationControlsRef = useRef<Viewer3DAnimationControls | null>(null)

  const viewerTarget = resolveViewerAssetTarget({ currentJob, apiUrl, workflowArtifact: workflowRunState.artifact })
  const modelSource = resolveViewerModelSource(viewerTarget)
  const viewerPresentation = resolveViewer3DPresentation(viewerTarget)
  const baseModelUrl = viewerPresentation.modelUrl
  const rigSourceWorkspacePath = resolveViewer3DRigSourceWorkspacePath(viewerTarget)
  const kimodoMetadataDescriptor = useMemo(
    () => resolveViewer3DKimodoMetadataDescriptor({ apiUrl, artifact: workflowRunState.artifact, modelUrl: baseModelUrl }),
    [apiUrl, baseModelUrl, workflowRunState.artifact],
  )
  const semanticHydrationSource = useMemo(
    () => resolveViewer3DSemanticHydrationSource({
      displayedMeshWorkspacePath: rigSourceWorkspacePath,
      descriptor: kimodoMetadataDescriptor,
      metadata: kimodoMetadata,
    }),
    [kimodoMetadata, kimodoMetadataDescriptor, rigSourceWorkspacePath],
  )
  const motionRetargetPresentation = useMemo(
    () => resolveViewer3DMotionRetargetModelPresentation({
      defaultModelUrl: baseModelUrl,
      apiUrl,
      session: motionRetargetState.session,
      diagnosticsMessages: motionRetargetState.diagnosticsMessages,
    }),
    [apiUrl, baseModelUrl, motionRetargetState.diagnosticsMessages, motionRetargetState.session],
  )
  const sourceRigFallback = useMemo(
    () => resolveViewer3DKimodoSourceRigFallback({
      apiUrl,
      defaultModelUrl: motionRetargetPresentation.modelUrl,
      descriptor: kimodoMetadataDescriptor,
      metadata: kimodoMetadata,
      previewHasUsableRig: rigStats.hasRig,
    }),
    [apiUrl, kimodoMetadata, kimodoMetadataDescriptor, motionRetargetPresentation.modelUrl, rigStats.hasRig],
  )
  const authoringPresentation = useMemo(
    () => resolveViewer3DAuthoringPresentation({
      baseModelUrl,
      currentJobId: currentJob?.id,
      rigSourceWorkspacePath,
      motionRetargetPresentation,
      sourceRigFallback,
    }),
    [baseModelUrl, currentJob?.id, motionRetargetPresentation, rigSourceWorkspacePath, sourceRigFallback],
  )
  const modelUrl = authoringPresentation.modelUrl
  const authoringRigSourceWorkspacePath = authoringPresentation.rigSourceWorkspacePath
  const sceneEditSource = resolveSceneEditSourceDescriptor({ currentJobId: currentJob?.id, modelSource })
  const sceneEditVisibility = resolveSceneEditControlsVisibility({ modelSource, source: sceneEditSource?.artifact ?? null })
  const canShowSceneEditControls = sceneEditVisibility.visible
  const hasRigEditorRail = Boolean(modelUrl && rigEditorState.summary)
  const hasPoseClipRail = Boolean(modelUrl && poseClipState.summary)
  const overlayLayout = resolveViewer3DOverlayLayout({
    modelUrl,
    hasEditRail: canShowSceneEditControls || hasRigEditorRail || hasPoseClipRail,
    poseClipVisibility,
    rigEditorVisibility,
    motionRetargetVisibility,
  })
  const activeCheckpointArtifact = workflowRunState.status === 'paused' ? workflowRunState.substitutionPoint?.inputArtifact : undefined
  const selectedPart = editPlan?.selectedPartId ? sceneParts.find((part) => part.id === editPlan.selectedPartId) : undefined
  const canSaveEditedCopy = Boolean(editPlan && editPlan.excludedPartIds.length > 0 && saveState.status !== 'saving')
  const landmarkMarkers = useMemo(() => resolveViewer3DLandmarkMarkers(landmarkSession?.completed), [landmarkSession?.completed])
  const rigTargetState = resolveViewer3DActiveRigTargetState({ rigEditorState, rigEditorVisibility, poseClipState, poseClipVisibility, selectedTarget: selectedRigTarget })
  const rigEditorPanelRenderState = resolveViewer3DRigEditorPanelRenderState({ modelUrl, rigState: rigEditorState, visibility: rigEditorVisibility })
  const poseClipPanelRenderState = resolveViewer3DPoseClipPanelRenderState({ modelUrl, poseState: poseClipState, visibility: poseClipVisibility })
  const rigHydrationWarning = rigRenameHydrationWarning && rigMetaHydrationWarning
    ? { status: 'warning' as const, messages: [...rigRenameHydrationWarning.messages, ...rigMetaHydrationWarning.messages] }
    : rigRenameHydrationWarning ?? rigMetaHydrationWarning
  const trustedHumanoidContractPresent = useMemo(
    () => hasTrustedHumanoidContractNaming(rigEditorState.rigMetaNamingByBoneId),
    [rigEditorState.rigMetaNamingByBoneId],
  )
  const humanoidReviewPresentation = useMemo(
    () => resolveViewer3DHumanoidReviewPresentationForHydrationSource({
      presentation: resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: humanoidReviewState.trustedContractPresent,
        draftResult: humanoidReviewState.draftResult,
        promotionResult: humanoidReviewState.promotionResult,
      }),
      semanticHydrationSource,
    }),
    [humanoidReviewState.draftResult, humanoidReviewState.promotionResult, humanoidReviewState.trustedContractPresent, semanticHydrationSource],
  )
  const rigDisplayNamingByBoneId = useMemo(
    () => resolveViewer3DEffectiveRigMetaNaming({
      summary: rigEditorState.summary,
      rigMetaNamingByBoneId: rigEditorState.rigMetaNamingByBoneId,
      draftResult: humanoidReviewState.draftResult,
      promotionResult: humanoidReviewState.promotionResult,
    }),
    [humanoidReviewState.draftResult, humanoidReviewState.promotionResult, rigEditorState.rigMetaNamingByBoneId, rigEditorState.summary],
  )

  const handleSelectRigEditorBone = useCallback((boneId: RigBoneId) => {
    setSelectedRigTarget((current) => {
      const summary = rigEditorState.summary
      return summary?.hasRig ? reduceViewer3DSelectedRigTargetState(current, { type: 'select-bone', summary, boneId }) : current
    })
    setRigEditorState((current) => reduceViewer3DRigEditorState(current, { type: 'select-bone', boneId }))
  }, [rigEditorState.summary])

  const handleSelectPoseClipBone = useCallback((boneId: RigBoneId) => {
    setSelectedRigTarget((current) => {
      const summary = poseClipState.summary
      return summary?.hasRig ? reduceViewer3DSelectedRigTargetState(current, { type: 'select-bone', summary, boneId }) : current
    })
    setPoseClipState((current) => {
      const summary = current.summary
      return summary?.hasRig ? reduceViewer3DPoseClipState(current, { type: 'select-bone', summary, boneId }) : current
    })
  }, [poseClipState.summary])

  const handleSelectActiveRigTarget = useCallback((boneId: RigBoneId) => {
    if (rigTargetState.activeMode === 'pose-clip') {
      handleSelectPoseClipBone(boneId)
      return
    }
    if (rigTargetState.activeMode === 'rig-editor') handleSelectRigEditorBone(boneId)
  }, [handleSelectPoseClipBone, handleSelectRigEditorBone, rigTargetState.activeMode])

  const rigEffectiveNaming = rigEditorPanelRenderState.shouldRenderPanel || poseClipPanelRenderState.shouldRenderPanel
    ? resolveRigEffectiveNaming(rigEditorState.summary ?? poseClipState.summary!, rigEditorState.renamePlan, rigDisplayNamingByBoneId)
    : undefined

  const rigOverlayProps = resolveViewer3DRigOverlayProps(rigTargetState, {
    onSelectBone: handleSelectActiveRigTarget,
  }, undefined, rigEffectiveNaming)

  useEffect(() => {
    if (!kimodoMetadataDescriptor) {
      setKimodoMetadata(null)
      setMotionRetargetState((current) => ({ ...current, session: undefined, diagnosticsMessages: [] }))
      return
    }

    let cancelled = false
    fetch(kimodoMetadataDescriptor.metadataUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load Kimodo metadata (${response.status}).`)
        return response.json() as Promise<Record<string, unknown>>
      })
      .then((metadata) => {
        if (cancelled) return
        setKimodoMetadata(metadata)
        const hydrated = hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
          descriptor: kimodoMetadataDescriptor,
          metadata,
          summary: motionRetargetState.summary,
          previousSession: motionRetargetState.session,
          renamePlan: rigEditorState.renamePlan,
          rigMetaNamingByBoneId: rigDisplayNamingByBoneId,
        })

        setMotionRetargetState((current) => {
          return {
            ...current,
            session: hydrated.session,
            selectedSourceBoneId: hydrated.session?.sourceBones.some((bone) => bone.sourceBoneId === current.selectedSourceBoneId)
              ? current.selectedSourceBoneId
              : hydrated.session?.sourceBones[0]?.sourceBoneId,
            diagnosticsMessages: hydrated.diagnosticsMessages,
          }
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (kimodoMetadataDescriptor.detectionMode === 'sibling-metadata') {
          setKimodoMetadata(null)
          setMotionRetargetState((current) => ({ ...current, session: undefined, diagnosticsMessages: [] }))
          return
        }
        const message = error instanceof Error ? error.message : 'Kimodo metadata could not be loaded.'
        setKimodoMetadata(null)
        setMotionRetargetState((current) => ({
          ...current,
          session: undefined,
          diagnosticsMessages: [message, 'Diagnostics-only inspection is available until a safe retarget artifact is found.'],
        }))
      })

    return () => {
      cancelled = true
    }
  }, [kimodoMetadataDescriptor, motionRetargetState.summary?.skeletonContextId, rigDisplayNamingByBoneId, rigEditorState.renamePlan])

  // Reset view state when model changes
  useEffect(() => {
    setSelected(false)
    setViewMode('solid')
    setAnimationPlaying(false)
    if (animationControlsRef.current) resetAnimationPlayback(animationControlsRef.current)
    setHasAnimations(false)
    setRigStats({ hasRig: false, skinnedMeshCount: 0, boneCount: 0, jointCount: 0 })
    setRigEditorState(createViewer3DRigEditorState())
    setRigEditorVisibility(createViewer3DRigEditorVisibilityState())
    setSelectedRigTarget(createViewer3DSelectedRigTargetState())
    if (poseClipSnapshotRef.current) {
      resetPoseClipPreview({ bonesById: poseClipBonesRef.current, snapshot: poseClipSnapshotRef.current })
      poseClipSnapshotRef.current = null
    }
    if (motionRetargetSnapshotRef.current) {
      resetMotionRetargetPreview({ bonesById: poseClipBonesRef.current, snapshot: motionRetargetSnapshotRef.current })
      motionRetargetSnapshotRef.current = null
    }
    setPoseClipState(createViewer3DPoseClipState())
    setPoseClipVisibility(createViewer3DPoseClipVisibilityState())
    setMotionRetargetState(createViewer3DMotionRetargetState())
    setMotionRetargetVisibility(createViewer3DMotionRetargetVisibilityState())
    setSceneEditMode('idle')
    setSceneParts([])
    setEditPlan(null)
    setSaveState({ status: 'idle' })
    setRigRenameSaveState({ status: 'idle' })
    setRigRenameHydrationWarning(null)
    setRigMetaHydrationWarning(null)
    setHumanoidReviewState(createViewer3DHumanoidReviewState())
    setKimodoMetadata(null)
    sceneRef.current = null
    poseClipBonesRef.current = new Map()
    setStoreMeshStats(null)
  }, [currentJob?.id, baseModelUrl])

  useEffect(() => {
    const request = resolveViewer3DRigMetaHydrationRequest(rigEditorState.summary, semanticHydrationSource)
    const token = createViewer3DRigMetaHydrationToken({
      modelUrl,
      summary: rigEditorState.summary,
      semanticSourceWorkspacePath: semanticHydrationSource?.semanticSourceWorkspacePath,
    })
    const reader = window.electron?.workspace?.artifacts?.readRigMetaSidecar
    if (!request || !token || !reader) {
      setRigMetaHydrationWarning(null)
      return
    }

    let cancelled = false
    setRigMetaHydrationWarning(null)
    reader(request).then((result) => {
      if (cancelled) return
      setRigEditorState((current) => {
        const currentToken = createViewer3DRigMetaHydrationToken({
          modelUrl,
          summary: current.summary,
          semanticSourceWorkspacePath: semanticHydrationSource?.semanticSourceWorkspacePath,
        })
        const hydration = applyViewer3DRigMetaHydrationResult({ state: current, result, token, currentToken })
        setRigMetaHydrationWarning(hydration.warning)
        return hydration.state
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Failed to read rigmeta sidecar.'
      setRigMetaHydrationWarning({ status: 'warning', messages: [message] })
    })

    return () => {
      cancelled = true
    }
  }, [modelUrl, rigEditorState.summary?.hasRig, rigEditorState.summary?.sourceWorkspacePath, rigEditorState.summary?.skeletonContextId, semanticHydrationSource?.semanticSourceWorkspacePath])

  useEffect(() => {
    const request = resolveViewer3DRigHydrationRequest(rigEditorState.summary, semanticHydrationSource)
    const token = createViewer3DRigHydrationToken({ modelUrl, summary: rigEditorState.summary })
    const reader = window.electron?.workspace?.artifacts?.readRigRenameSidecar
    if (!request || !token || !reader) {
      setRigRenameHydrationWarning(null)
      return
    }

    let cancelled = false
    setRigRenameHydrationWarning(null)
    reader(request).then((result) => {
      if (cancelled) return
      setRigEditorState((current) => {
        const currentToken = createViewer3DRigHydrationToken({ modelUrl, summary: current.summary })
        const hydration = applyViewer3DRigHydrationResult({ state: current, result, token, currentToken })
        setRigRenameHydrationWarning(hydration.warning)
        return hydration.state
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Failed to read rig rename sidecar.'
      setRigRenameHydrationWarning({ status: 'warning', messages: [message] })
    })

    return () => {
      cancelled = true
    }
  }, [modelUrl, rigEditorState.summary?.hasRig, rigEditorState.summary?.sourceWorkspacePath, rigEditorState.summary?.skeletonContextId])

  useEffect(() => {
    const request = resolveViewer3DHumanoidHydrationRequest(rigEditorState.summary, semanticHydrationSource)
    const draftReader = window.electron?.workspace?.artifacts?.readHumanoidDraftSidecar
    const promotionReader = window.electron?.workspace?.artifacts?.readHumanoidPromotionSidecar
    if (!request || !draftReader || !promotionReader) {
      setHumanoidReviewState((current) => createViewer3DHumanoidReviewState(current.meshWorkspacePath))
      return
    }

    let cancelled = false
    setHumanoidReviewState((current) => ({ ...current, meshWorkspacePath: request.displayedMeshWorkspacePath, trustedContractPresent: trustedHumanoidContractPresent, loadState: 'loading' }))

    Promise.all([draftReader(request.draft), promotionReader(request.promotion)]).then(([draftResult, promotionResult]) => {
      if (cancelled) return
      setHumanoidReviewState((current) => applyViewer3DHumanoidHydration({
        state: current,
        meshWorkspacePath: request.displayedMeshWorkspacePath,
        trustedContractPresent: trustedHumanoidContractPresent,
        draftResult,
        promotionResult,
      }))
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Failed to read humanoid draft or promotion sidecar.'
      setHumanoidReviewState((current) => ({
        ...current,
        meshWorkspacePath: request.displayedMeshWorkspacePath,
        trustedContractPresent: trustedHumanoidContractPresent,
        loadState: 'error',
        draftResult: { success: false, status: 'error', error: message },
        promotionResult: current.promotionResult,
        saveState: { status: 'idle' },
      }))
    })

    return () => {
      cancelled = true
    }
  }, [rigEditorState.summary?.hasRig, rigEditorState.summary?.sourceWorkspacePath, rigEditorState.summary?.skeletonContextId, semanticHydrationSource?.semanticSourceWorkspacePath, semanticHydrationSource?.sourceKind, trustedHumanoidContractPresent])

  useEffect(() => {
    const request = resolveViewer3DPoseClipHydrationRequest(poseClipState.summary)
    const token = createViewer3DPoseClipHydrationToken({ modelUrl, summary: poseClipState.summary })
    const reader = window.electron?.workspace?.artifacts?.readPoseClipSidecar
    if (!request || !token || !reader) return

    let cancelled = false
    reader(request).then((result) => {
      if (cancelled) return
      setPoseClipState((current) => {
        const currentToken = createViewer3DPoseClipHydrationToken({ modelUrl, summary: current.summary })
        return applyViewer3DPoseClipHydrationResult({ state: current, result, token, currentToken }).state
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Failed to read pose clip sidecar.'
      setPoseClipState((current) => ({ ...current, loadState: 'error', loadError: message, warning: { status: 'warning', messages: [message] } }))
    })

    return () => {
      cancelled = true
    }
  }, [modelUrl, poseClipState.summary?.hasRig, poseClipState.summary?.sourceWorkspacePath, poseClipState.summary?.skeletonContextId])

  useEffect(() => {
    const request = resolveViewer3DMotionRetargetHydrationRequest(motionRetargetState.summary, motionRetargetState.session)
    const token = createViewer3DMotionRetargetHydrationToken({ modelUrl, summary: motionRetargetState.summary })
    const reader = window.electron?.workspace?.artifacts?.readMotionRetargetSidecar
    if (!reader || !request || !token) return

    let cancelled = false
    reader(request).then((result) => {
      if (cancelled) return
      setMotionRetargetState((current) => applyViewer3DMotionRetargetHydrationResult({
        state: current,
        result,
        token,
        currentToken: createViewer3DMotionRetargetHydrationToken({ modelUrl, summary: current.summary }),
        showNotFoundMessage: false,
      }).state)
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Failed to read motion retarget sidecar.'
      setMotionRetargetState((current) => ({
        ...current,
        diagnosticsMessages: [message],
        loadState: 'error',
        loadMessage: message,
      }))
    })

    return () => {
      cancelled = true
    }
  }, [modelUrl, motionRetargetState.summary?.hasRig, motionRetargetState.summary?.sourceWorkspacePath, motionRetargetState.summary?.skeletonContextId])

  useEffect(() => {
    if (!canShowSceneEditControls || !sceneEditSource) {
      setSceneEditMode('idle')
      setEditPlan(null)
      return
    }

    const sourceArtifactId = activeCheckpointArtifact?.id ?? sceneEditSource.artifactId
    setEditPlan(createEditPlan({
      sourceArtifactId,
      ...(activeCheckpointArtifact?.versionId !== undefined ? { sourceVersionId: activeCheckpointArtifact.versionId } : {}),
      sourceWorkspacePath: sceneEditSource.artifact.workspacePath,
    }))
  }, [activeCheckpointArtifact?.id, activeCheckpointArtifact?.versionId, canShowSceneEditControls, sceneEditSource?.artifactId, sceneEditSource?.artifact.workspacePath])

  // Delete key removes the model from the scene
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return
      if (document.activeElement instanceof HTMLInputElement) return
      if (!selected) return
      if (!viewerPresentation.canDeleteSelectedModel) {
        setSelected(false)
        return
      }
      setCurrentJob(null)
      setSelected(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selected, setCurrentJob, viewerPresentation.canDeleteSelectedModel])

  const handleScreenshot = () => {
    const dataUrl = isSplat
      ? splatRef.current?.screenshot() ?? null
      : canvasRef.current?.toDataURL('image/png') ?? null
    if (!dataUrl) return
    const link = document.createElement('a')
    link.download = `modly-${Date.now()}.png`
    link.href = dataUrl
    link.click()
  }

  const handleAnimationAvailability = (available: boolean) => {
    setHasAnimations(available)
    if (!available) {
      setAnimationPlaying(false)
    }
  }

  const handleRigSkeletonSummary = useCallback((summary: RigSkeletonSummary) => {
    setRigEditorState((current) => reduceViewer3DRigEditorState(current, { type: 'set-summary', summary }))
    setRigEditorVisibility((current) => reduceViewer3DRigEditorVisibilityState(current, { type: 'set-summary', summary }))
    setPoseClipState((current) => reduceViewer3DPoseClipState(current, { type: 'set-summary', summary }))
    setPoseClipVisibility((current) => reduceViewer3DPoseClipVisibilityState(current, { type: 'set-summary', summary }))
    setMotionRetargetState((current) => reduceViewer3DMotionRetargetState(current, { type: 'set-summary', summary }))
    setMotionRetargetVisibility((current) => reduceViewer3DMotionRetargetVisibilityState(current, { type: 'set-summary', summary }))
    setSelectedRigTarget((current) => reduceViewer3DSelectedRigTargetState(current, { type: 'set-summary', summary }))
  }, [])

  const handlePoseClipBonesReady = useCallback((bonesById: Map<RigBoneId, THREE.Bone>) => {
    poseClipBonesRef.current = bonesById
  }, [])

  const handleSceneReady = useCallback((scene: THREE.Object3D, parts: ScenePart[]) => {
    sceneRef.current = scene
    setSceneParts(parts)
  }, [])

  const handleSceneSelect = (partId: string | null) => {
    setSelected(true)
    if (!editPlan || sceneEditMode !== 'editing') return
    if (!partId) return
    setEditPlan(editPlanReducer(editPlan, { type: 'select-part', partId }))
  }

  const handleHideSelectedPart = () => {
    if (!editPlan?.selectedPartId || saveState.status === 'saving') return
    setEditPlan(editPlanReducer(editPlan, { type: 'exclude-selected-part' }))
    setSaveState({ status: 'idle' })
  }

  const handleResetSceneEdit = () => {
    if (!editPlan || saveState.status === 'saving') return
    setEditPlan(editPlanReducer(editPlan, { type: 'reset' }))
    setSaveState({ status: 'idle' })
  }

  const handleClearSceneEdit = () => {
    if (!editPlan || saveState.status === 'saving') return
    setEditPlan(editPlanReducer(editPlan, { type: 'clear' }))
    setSaveState({ status: 'idle' })
  }

  const handleSaveEditedCopy = async () => {
    const scene = sceneRef.current
    if (!scene || !editPlan || !canSaveEditedCopy) return
    const writer = window.electron?.workspace?.artifacts?.writeEditedSceneArtifact
    if (!writer) {
      setSaveState({ status: 'error', message: 'Workspace artifact writer is unavailable.' })
      return
    }
    if (!activeCheckpointArtifact) {
      setSaveState({ status: 'error', message: 'No active Wait checkpoint is available for replacement.' })
      return
    }

    setSaveState({ status: 'saving' })
    const gltfExporter = new GLTFExporter()
    const result = await saveEditedScenePendingReplacement({
      scene,
      parts: sceneParts,
      editPlan,
      createdAt: new Date().toISOString(),
      sourceArtifact: activeCheckpointArtifact,
      setPendingReplacement,
      exporter: {
        parse: (input, onDone, onError, options) => gltfExporter.parse(input, onDone, (error) => onError?.(error), options),
      },
      writer,
    })

    if (result.success) {
      setSaveState({ status: 'saved', glbWorkspacePath: result.glbWorkspacePath, sidecarWorkspacePath: result.sidecarWorkspacePath })
      return
    }

    setSaveState({ status: 'error', message: result.error })
  }

  const handleSaveRigAliases = async () => {
    const writer = window.electron?.workspace?.artifacts?.writeRigRenameSidecar
    if (!writer) {
      setRigRenameSaveState({ status: 'error', message: 'Workspace rig alias writer is unavailable.' })
      return
    }

    setRigRenameSaveState({ status: 'saving' })
    const result = await writeViewer3DRigRenameSidecar({ state: rigEditorState, writer })
    if (result.success) {
      setRigRenameSaveState({ status: 'saved', sidecarWorkspacePath: result.sidecarWorkspacePath })
      return
    }

    setRigRenameSaveState({ status: 'error', message: result.error })
  }

  const handleSaveHumanoidPromotion = async () => {
    const writer = window.electron?.workspace?.artifacts?.writeHumanoidPromotionSidecar
    const auditInput = resolveViewer3DHumanoidPromotionButtonAudit({
      rationale: humanoidReviewState.rationale,
      confirmationChecked: humanoidReviewState.confirmationChecked,
    })
    const gate = resolveViewer3DHumanoidPromotionGate({
      presentation: humanoidReviewPresentation,
      rationale: auditInput.rationale,
      confirmationChecked: auditInput.confirmationChecked,
      writerAvailable: Boolean(writer),
    })
    if (!gate.allowed) {
      setHumanoidReviewState((current) => ({ ...current, saveState: { status: 'error', message: gate.reason } }))
      return
    }
    if (!writer || !humanoidReviewState.meshWorkspacePath || !isHumanoidDraftFound(humanoidReviewState.draftResult)) {
      setHumanoidReviewState((current) => ({ ...current, saveState: { status: 'error', message: 'No valid humanoid draft is available for promotion.' } }))
      return
    }

    const currentPromotion = isHumanoidPromotionFound(humanoidReviewState.promotionResult)
      ? humanoidReviewState.promotionResult.sidecar
      : undefined
    const request = buildViewer3DHumanoidPromotionWriteRequest({
      meshWorkspacePath: humanoidReviewState.meshWorkspacePath,
      draft: humanoidReviewState.draftResult.sidecar,
      existingPromotion: currentPromotion,
      proposedAssignments: humanoidReviewState.proposedAssignments,
      rationale: auditInput.rationale,
      createdAt: new Date().toISOString(),
      confirmedBy: DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY,
      confirmedByLabel: DEFAULT_VIEWER3D_HUMANOID_CONFIRMED_BY_LABEL,
      method: resolveViewer3DHumanoidPromotionMethod({
        currentJobId: currentJob?.id,
        workflowArtifactPresent: Boolean(workflowRunState.artifact),
      }),
      promotionId: crypto.randomUUID(),
    })

    setHumanoidReviewState((current) => ({ ...current, saveState: { status: 'saving' } }))
    const result = await writer(request)
    setHumanoidReviewState((current) => result.success
      ? {
          ...current,
          promotionResult: { success: true, status: 'found', sidecarWorkspacePath: result.sidecarWorkspacePath, sidecar: result.sidecar },
          saveState: { status: 'saved', sidecarWorkspacePath: result.sidecarWorkspacePath },
        }
      : { ...current, saveState: { status: 'error', message: result.error } })
  }

  const handleCapturePoseClipKeyframe = (boneId: RigBoneId, timeSeconds: number) => {
    const summary = poseClipState.summary
    const bone = poseClipBonesRef.current.get(boneId)
    if (!summary?.hasRig || !bone) return
    setPoseClipState((current) => reduceViewer3DPoseClipState(current, {
      type: 'capture-keyframe',
      summary,
      boneId,
      timeSeconds,
      rotation: { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w },
    }))
  }

  const handleSaveMotionRetargetSidecar = async () => {
    const writer = window.electron?.workspace?.artifacts?.writeMotionRetargetSidecar
    if (!writer) {
      setMotionRetargetState((current) => ({ ...current, saveState: 'error', saveMessage: 'Workspace motion retarget writer is unavailable.' }))
      return
    }
    setMotionRetargetState((current) => ({ ...current, saveState: 'saving', saveMessage: undefined }))
    const result = await writeViewer3DMotionRetargetSidecar({ state: motionRetargetState, writer })
    setMotionRetargetState((current) => result.success
      ? { ...current, saveState: 'saved', saveMessage: `Saved motion retarget sidecar: ${result.sidecarWorkspacePath}` }
      : { ...current, saveState: 'error', saveMessage: result.error })
  }

  const handleLoadMotionRetargetSidecar = async () => {
    const reader = window.electron?.workspace?.artifacts?.readMotionRetargetSidecar
    const request = resolveViewer3DMotionRetargetHydrationRequest(motionRetargetState.summary, motionRetargetState.session)
    const token = createViewer3DMotionRetargetHydrationToken({ modelUrl, summary: motionRetargetState.summary })
    if (!reader || !request || !token) {
      setMotionRetargetState((current) => ({ ...current, loadState: 'error', loadMessage: 'Workspace motion retarget reader is unavailable for this rig.' }))
      return
    }
    setMotionRetargetState((current) => ({ ...current, loadState: 'loading', loadMessage: undefined }))
    const result = await reader(request)
    setMotionRetargetState((current) => applyViewer3DMotionRetargetHydrationResult({
      state: current,
      result,
      token,
      currentToken: createViewer3DMotionRetargetHydrationToken({ modelUrl, summary: current.summary }),
    }).state)
  }

  const handleExportMotionRetargetPoseClipCompanion = async () => {
    const writer = window.electron?.workspace?.artifacts?.writePoseClipSidecar
    if (!writer) {
      setMotionRetargetState((current) => ({ ...current, exportState: 'error', exportMessage: 'Workspace Pose/Clip writer is unavailable.' }))
      return
    }
    setMotionRetargetState((current) => ({ ...current, exportState: 'exporting', exportMessage: undefined }))
    const result = await writeViewer3DMotionRetargetPoseClipCompanion({ state: motionRetargetState, writer })
    setMotionRetargetState((current) => result.success
      ? { ...current, exportState: 'exported', exportMessage: `Exported Pose/Clip companion: ${result.sidecarWorkspacePath}` }
      : { ...current, exportState: 'error', exportMessage: result.error })
  }

  const handleOpenMotionRetargetArtifact = useCallback(async (artifact: MotionRetargetArtifactLink) => {
    const viewerArtifact = artifact as Viewer3DMotionRetargetArtifactEntry
    if (viewerArtifact.openMode === 'workspace-preview' && !window.electron?.workspace?.artifacts) {
      setArtifactPreviewState({
        status: 'binary',
        title: artifact.label,
        workspacePath: artifact.workspacePath,
        displayName: artifact.downloadName ?? artifact.label,
        byteLength: 0,
        binaryKind: 'error',
        message: 'Workspace artifact preview is unavailable.',
      })
      return
    }

    const opened = await openViewer3DMotionRetargetArtifact({
      state: motionRetargetState,
      artifact: viewerArtifact,
      previewReader: viewerArtifact.openMode === 'workspace-preview'
        ? previewWorkspaceArtifact
        : async () => ({ success: false, error: 'Workspace artifact preview is unavailable.' }),
    })
    setMotionRetargetState(opened.motionRetargetState)
    setArtifactPreviewState(opened.previewState)
  }, [motionRetargetState])

  const handleDownloadMotionRetargetArtifact = useCallback(async (artifact: MotionRetargetArtifactLink) => {
    if (!window.electron?.workspace?.artifacts) {
      setMotionRetargetState((current) => ({ ...current, exportState: 'error', exportMessage: 'Workspace artifact download is unavailable.' }))
      return
    }

    const result = await downloadViewer3DMotionRetargetArtifact({ artifact: artifact as Viewer3DMotionRetargetArtifactEntry, downloader: downloadWorkspaceArtifact })
    if (!result.success) {
      setMotionRetargetState((current) => ({ ...current, exportState: 'error', exportMessage: result.error }))
    }
  }, [])

  const handlePlayMotionRetargetPreview = useCallback(() => {
    const bonesById = poseClipBonesRef.current
    if (bonesById.size === 0) return
    setAnimationPlaying(false)
    setMotionRetargetState((current) => {
      const started = startViewer3DMotionRetargetPreview({
        state: current,
        bonesById,
        poseSnapshot: motionRetargetSnapshotRef.current,
        gltfActions: animationControlsRef.current?.actions ?? [],
        gltfAnimationPlaying: animationPlaying,
      })
      motionRetargetSnapshotRef.current = started.poseSnapshot
      return started.state
    })
  }, [animationPlaying])

  const handlePauseMotionRetargetPreview = useCallback(() => {
    setMotionRetargetState((current) => ({ ...current, previewState: 'paused' }))
  }, [])

  const handleResetMotionRetargetPreview = useCallback(() => {
    setAnimationPlaying(false)
    setMotionRetargetState((current) => {
      const activeBackend: MotionPlaybackBackend = current.session?.selectedPreview === 'animated-glb' && hasAnimations
        ? 'animated-glb'
        : 'local-retarget-preview'
      const reset = resetViewer3DActiveMotionPlayback({
        state: current,
        activeBackend,
        bonesById: poseClipBonesRef.current,
        localSnapshot: motionRetargetSnapshotRef.current,
        animation: {
          actions: animationControlsRef.current?.actions ?? [],
          mixer: animationControlsRef.current?.mixer,
          playing: animationPlaying,
        },
      })
      motionRetargetSnapshotRef.current = reset.localSnapshot
      return reset.state
    })
  }, [animationPlaying, hasAnimations])

  const handleScrubMotionRetargetPreview = useCallback((timeSeconds: number) => {
    const bonesById = poseClipBonesRef.current
    if (bonesById.size === 0) return
    setAnimationPlaying(false)
    setMotionRetargetState((current) => {
      const scrubbed = scrubViewer3DMotionRetargetPreviewTime({
        state: current,
        bonesById,
        poseSnapshot: motionRetargetSnapshotRef.current,
        gltfActions: animationControlsRef.current?.actions ?? [],
        gltfAnimationPlaying: animationPlaying,
        timeSeconds,
      })
      motionRetargetSnapshotRef.current = scrubbed.poseSnapshot
      return scrubbed.state
    })
  }, [animationPlaying])

  const handlePoseClipCurrentTimeChange = useCallback((timeSeconds: number) => {
    const bonesById = poseClipBonesRef.current
    if (!poseClipSnapshotRef.current && bonesById.size > 0) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
    setAnimationPlaying(false)
    setPoseClipState((current) => {
      const next = reduceViewer3DPoseClipState(current, { type: 'set-current-time', timeSeconds })
      if (poseClipSnapshotRef.current && bonesById.size > 0) {
        restoreThenEvaluatePoseClipPreview({ plan: next.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: next.currentTimeSeconds })
      }
      return { ...next, previewState: 'paused' }
    })
  }, [])

  const handlePoseClipMetadataChange = useCallback((metadata: { durationSeconds?: number; fps?: number }) => {
    setPoseClipState((current) => {
      const summary = current.summary
      return summary?.hasRig ? reduceViewer3DPoseClipState(current, { type: 'set-clip-metadata', summary, ...metadata }) : current
    })
  }, [])

  const handleCaptureAndAdvancePoseClipKeyframe = useCallback((boneId: RigBoneId) => {
    const summary = poseClipState.summary
    const bone = poseClipBonesRef.current.get(boneId)
    if (!summary?.hasRig || !bone) return
    setPoseClipState((current) => reduceViewer3DPoseClipState(current, {
      type: 'capture-and-advance',
      summary,
      boneId,
      rotation: { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w },
    }))
  }, [poseClipState.summary])

  const handleUpdateSelectedPoseClipKeyframe = useCallback((_keyframeId: string, boneId: RigBoneId) => {
    const summary = poseClipState.summary
    const bone = poseClipBonesRef.current.get(boneId)
    const bonesById = poseClipBonesRef.current
    if (!summary?.hasRig || !bone) return
    if (!poseClipSnapshotRef.current && bonesById.size > 0) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
    setAnimationPlaying(false)
    setPoseClipState((current) => {
      const next = reduceViewer3DPoseClipState(current, {
        type: 'update-selected-keyframe',
        summary,
        boneId,
        rotation: { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w },
      })
      if (poseClipSnapshotRef.current && bonesById.size > 0) {
        restoreThenEvaluatePoseClipPreview({ plan: next.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: next.currentTimeSeconds })
      }
      return { ...next, previewState: 'paused' }
    })
  }, [poseClipState.summary])

  const handleDeleteSelectedPoseClipKeyframe = useCallback((_keyframeId: string) => {
    const summary = poseClipState.summary
    if (!summary?.hasRig) return
    setPoseClipState((current) => reduceViewer3DPoseClipState(current, { type: 'delete-selected-keyframe', summary }))
  }, [poseClipState.summary])

  const handleMoveSelectedPoseClipKeyframe = useCallback((_keyframeId: string, timeSeconds: number) => {
    const summary = poseClipState.summary
    const bonesById = poseClipBonesRef.current
    if (!summary?.hasRig) return
    setAnimationPlaying(false)
    setPoseClipState((current) => {
      const next = reduceViewer3DPoseClipState(current, { type: 'move-selected-keyframe', summary, timeSeconds })
      if (!poseClipSnapshotRef.current && bonesById.size > 0) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
      if (poseClipSnapshotRef.current && bonesById.size > 0) {
        restoreThenEvaluatePoseClipPreview({ plan: next.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: next.currentTimeSeconds })
      }
      return { ...next, previewState: 'paused' }
    })
  }, [poseClipState.summary])

  const handleShiftSelectedPoseClipKeyframe = useCallback((_keyframeId: string, deltaSeconds: number) => {
    const summary = poseClipState.summary
    const bonesById = poseClipBonesRef.current
    if (!summary?.hasRig) return
    setAnimationPlaying(false)
    setPoseClipState((current) => {
      const next = reduceViewer3DPoseClipState(current, { type: 'shift-selected-keyframe', summary, deltaSeconds })
      if (!poseClipSnapshotRef.current && bonesById.size > 0) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
      if (poseClipSnapshotRef.current && bonesById.size > 0) {
        restoreThenEvaluatePoseClipPreview({ plan: next.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: next.currentTimeSeconds })
      }
      return { ...next, previewState: 'paused' }
    })
  }, [poseClipState.summary])

  const handleDuplicateSelectedPoseClipKeyframe = useCallback((_keyframeId: string) => {
    const summary = poseClipState.summary
    const bonesById = poseClipBonesRef.current
    if (!summary?.hasRig) return
    setAnimationPlaying(false)
    setPoseClipState((current) => {
      const next = reduceViewer3DPoseClipState(current, { type: 'duplicate-selected-keyframe', summary })
      if (!poseClipSnapshotRef.current && bonesById.size > 0) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
      if (poseClipSnapshotRef.current && bonesById.size > 0) {
        restoreThenEvaluatePoseClipPreview({ plan: next.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: next.currentTimeSeconds })
      }
      return { ...next, previewState: 'paused' }
    })
  }, [poseClipState.summary])

  const handlePoseClipPreviewPlay = () => {
    const bonesById = poseClipBonesRef.current
    if (poseClipState.plan.keyframes.length === 0 || bonesById.size === 0) return
    if (!poseClipSnapshotRef.current) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
    setAnimationPlaying(false)
    restoreThenEvaluatePoseClipPreview({ plan: poseClipState.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: poseClipState.currentTimeSeconds })
    setPoseClipState((current) => ({ ...current, previewState: 'playing' }))
  }

  const handlePoseClipPreviewPause = () => {
    setPoseClipState((current) => ({ ...current, previewState: 'paused' }))
  }

  const handlePoseClipPreviewReset = useCallback(() => {
    if (poseClipSnapshotRef.current) {
      resetPoseClipPreview({ bonesById: poseClipBonesRef.current, snapshot: poseClipSnapshotRef.current })
      poseClipSnapshotRef.current = null
    }
    setPoseClipState((current) => ({ ...current, previewState: 'idle', currentTimeSeconds: 0 }))
  }, [])

  const handleRotatePoseClipSelectedTarget = useCallback((boneId: RigBoneId, axis: PoseClipRotationAxis, degreesDelta: number) => {
    const bonesById = poseClipBonesRef.current
    if (!poseClipSnapshotRef.current) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
    const result = applyLocalPoseClipRotation({ bonesById, boneId, axis, degreesDelta })
    if (!result.applied) return
    setPoseClipState((current) => ({ ...current, previewState: 'paused' }))
  }, [])

  const handleResetPoseClipSelectedTarget = useCallback((boneId: RigBoneId) => {
    if (!poseClipSnapshotRef.current) return
    resetPoseClipSelectedBone({ bonesById: poseClipBonesRef.current, snapshot: poseClipSnapshotRef.current, boneId })
    setPoseClipState((current) => ({ ...current, previewState: 'idle' }))
  }, [])

  const handleSavePoseClipSidecar = async () => {
    const writer = window.electron?.workspace?.artifacts?.writePoseClipSidecar
    if (!writer) {
      setPoseClipState((current) => ({ ...current, saveState: 'error', saveError: 'Workspace pose clip writer is unavailable.' }))
      return
    }
    setPoseClipState((current) => ({ ...current, saveState: 'saving', saveError: undefined }))
    const result = await writeViewer3DPoseClipSidecar({ state: poseClipState, writer })
    setPoseClipState((current) => result.success
      ? { ...current, saveState: 'saved', saveError: undefined }
      : { ...current, saveState: 'error', saveError: result.error })
  }

  const handleLoadPoseClipSidecar = async () => {
    const reader = window.electron?.workspace?.artifacts?.readPoseClipSidecar
    const request = resolveViewer3DPoseClipHydrationRequest(poseClipState.summary)
    const token = createViewer3DPoseClipHydrationToken({ modelUrl, summary: poseClipState.summary })
    if (!reader || !request || !token) {
      setPoseClipState((current) => ({ ...current, loadState: 'error', loadError: 'Workspace pose clip reader is unavailable for this rig.' }))
      return
    }
    setPoseClipState((current) => ({ ...current, loadState: 'loading', loadError: undefined }))
    const result = await reader(request)
    setPoseClipState((current) => applyViewer3DPoseClipHydrationResult({ state: current, result, token, currentToken: createViewer3DPoseClipHydrationToken({ modelUrl, summary: current.summary }) }).state)
  }

  useEffect(() => {
    if (poseClipState.previewState !== 'playing') return
    const interval = window.setInterval(() => {
      setPoseClipState((current) => {
        if (current.previewState !== 'playing') return current
        const nextTime = current.currentTimeSeconds >= current.plan.clip.durationSeconds ? 0 : Math.min(current.plan.clip.durationSeconds, current.currentTimeSeconds + 1 / current.plan.clip.fps)
        if (poseClipSnapshotRef.current) {
          restoreThenEvaluatePoseClipPreview({ plan: current.plan, bonesById: poseClipBonesRef.current, snapshot: poseClipSnapshotRef.current, timeSeconds: nextTime })
        } else {
          evaluatePoseClipPreview({ plan: current.plan, bonesById: poseClipBonesRef.current, timeSeconds: nextTime })
        }
        return { ...current, currentTimeSeconds: nextTime }
      })
    }, 1000 / Math.max(1, poseClipState.plan.clip.fps))
    return () => window.clearInterval(interval)
  }, [poseClipState.previewState, poseClipState.plan.clip.fps])

  useEffect(() => {
    if (poseClipVisibility.isOpen) return
    handlePoseClipPreviewReset()
  }, [poseClipVisibility.isOpen, handlePoseClipPreviewReset])

  useEffect(() => {
    const wasOpen = motionRetargetWasOpenRef.current
    const isOpen = motionRetargetVisibility.isOpen
    motionRetargetWasOpenRef.current = isOpen
    if (!shouldResetViewer3DMotionRetargetPreviewForVisibilityChange({ wasOpen, isOpen })) return
    setMotionRetargetState((current) => {
      const reset = resetViewer3DScopedMotionRetargetPreviewOnClose({
        state: current,
        bonesById: poseClipBonesRef.current,
        localSnapshot: motionRetargetSnapshotRef.current,
        globalAnimationPlaying: animationPlaying,
      })
      motionRetargetSnapshotRef.current = reset.localSnapshot
      return reset.state
    })
  }, [animationPlaying, motionRetargetVisibility.isOpen])

  useEffect(() => {
    if (motionRetargetState.previewState !== 'playing') return
    const preview = resolveViewer3DMotionRetargetPreviewClip(motionRetargetState)
    if (!preview.available || !preview.plan) return
    const interval = window.setInterval(() => {
      setMotionRetargetState((current) => {
        if (current.previewState !== 'playing') return current
        const nextTime = current.previewCurrentTimeSeconds >= preview.plan!.clip.durationSeconds
          ? 0
          : Math.min(preview.plan!.clip.durationSeconds, current.previewCurrentTimeSeconds + 1 / preview.plan!.clip.fps)
        if (!motionRetargetSnapshotRef.current) {
          motionRetargetSnapshotRef.current = takeMotionRetargetPreviewSnapshot(poseClipBonesRef.current)
        }
        restoreThenEvaluateMotionRetargetPreview({
          plan: preview.plan!,
          bonesById: poseClipBonesRef.current,
          snapshot: motionRetargetSnapshotRef.current,
          timeSeconds: nextTime,
        })
        return { ...current, previewCurrentTimeSeconds: nextTime }
      })
    }, 1000 / Math.max(1, preview.plan.clip.fps))
    return () => window.clearInterval(interval)
  }, [motionRetargetState])


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
          onPointerMissed={() => setSelected(false)}
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
            <Suspense fallback={null}>
              <directionalLight position={[5, 8, 5]} color={lightSettings.mainColor} intensity={lightSettings.mainIntensity} castShadow />
              <directionalLight position={[-4, 2, -4]} color={lightSettings.fillColor} intensity={lightSettings.fillIntensity} />
              <MeshModel
                url={modelUrl}
                rigSourceWorkspacePath={authoringRigSourceWorkspacePath}
                viewMode={viewMode}
                animationPlaying={animationPlaying}
                editMode={sceneEditMode === 'editing'}
                sceneParts={sceneParts}
                onStats={setStoreMeshStats}
                onSelect={handleSceneSelect}
                onAnimationAvailability={handleAnimationAvailability}
                onAnimationControlsReady={(controls) => { animationControlsRef.current = controls }}
                onRigStats={setRigStats}
                onRigSkeletonSummary={handleRigSkeletonSummary}
                onPoseClipBonesReady={handlePoseClipBonesReady}
                rigSkeletonSummary={rigTargetState.summary}
                selectedBoneId={rigTargetState.selectedBoneId}
                onSceneReady={handleSceneReady}
                landmarkPicking={landmarkSession ? {
                  activeLandmarkId: landmarkSession.activeLandmarkId,
                  canvas: canvasRef.current,
                  onPoint: markLandmark,
                } : undefined}
              />
              <LandmarkMarkers markers={landmarkMarkers} onSelectLandmark={selectLandmarkForEditing} />
            </Suspense>
          ) : null}

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

          <GizmoHelper alignment="top-right" margin={[72, 72]} renderPriority={modelUrl && currentJob ? 2 : 0}>
            <GizmoBubbles />
          </GizmoHelper>
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
              hasRig={rigStats.hasRig}
              onViewMode={setViewMode}
              onAutoRotate={() => setAutoRotate((v) => !v)}
              onAnimationToggle={() => setAnimationPlaying((v) => hasAnimations ? !v : false)}
              onScreenshot={handleScreenshot}
            />
            <ViewerEditToolbar
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
              rigEditorControls={rigEditorState.summary ? {
                active: Boolean(rigEditorState.summary.hasRig && rigEditorVisibility.isOpen),
                summary: rigEditorState.summary,
                onOpenRigEditor: () => setRigEditorVisibility((current) => reduceViewer3DRigEditorVisibilityState(current, { type: 'toggle', summary: rigEditorState.summary })),
              } : undefined}
              poseClipControls={poseClipState.summary ? {
                active: Boolean(poseClipState.summary.hasRig && poseClipVisibility.isOpen),
                summary: poseClipState.summary,
                onOpenPoseClip: () => setPoseClipVisibility((current) => reduceViewer3DPoseClipVisibilityState(current, { type: 'toggle', summary: poseClipState.summary })),
              } : undefined}
            />
          </>
        )}

        {rigEditorPanelRenderState.shouldRenderPanel && (
          <div className={`absolute top-4 ${overlayLayout.editPanelClassName} z-20 w-80 max-w-[calc(100%-5rem)]`}>
            <RigEditorPanel
              {...resolveViewer3DRigEditorPanelProps({ ...rigEditorState, selectedBoneId: rigTargetState.selectedBoneId }, {
                onSelectBone: handleSelectRigEditorBone,
                onAliasChange: (boneId, alias) => setRigEditorState((current) => reduceViewer3DRigEditorState(current, { type: 'set-alias', boneId, alias })),
                onCancelAlias: (boneId) => setRigEditorState((current) => reduceViewer3DRigEditorState(current, { type: 'cancel-alias', boneId })),
                onRevertAliases: () => setRigEditorState((current) => reduceViewer3DRigEditorState(current, { type: 'revert-aliases' })),
                onSaveAliases: handleSaveRigAliases,
              }, rigHydrationWarning, {
                rigMetaNamingByBoneId: rigDisplayNamingByBoneId,
                humanoidReview: resolveViewer3DRigHumanoidReviewProps({
                  presentation: humanoidReviewPresentation,
                  saveState: humanoidReviewState.saveState,
                  onPromote: handleSaveHumanoidPromotion,
                }),
              })}
            />
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
                onClick={() => setArtifactPreviewState(createViewer3DArtifactPreviewState())}
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
                onCurrentTimeChange: handlePoseClipCurrentTimeChange,
                onClipMetadataChange: handlePoseClipMetadataChange,
                onCaptureKeyframe: handleCapturePoseClipKeyframe,
                onCaptureAndAdvance: handleCaptureAndAdvancePoseClipKeyframe,
                onSelectKeyframe: (keyframeId, boneId) => {
                  const summary = poseClipState.summary
                  if (summary?.hasRig) {
                    const bonesById = poseClipBonesRef.current
                    if (!poseClipSnapshotRef.current && bonesById.size > 0) poseClipSnapshotRef.current = takePoseClipQuaternionSnapshot(bonesById)
                    setAnimationPlaying(false)
                    setSelectedRigTarget((current) => reduceViewer3DSelectedRigTargetState(current, { type: 'select-bone', summary, boneId }))
                    setPoseClipState((current) => {
                      const next = reduceViewer3DPoseClipState(current, { type: 'select-keyframe', summary, keyframeId })
                      if (poseClipSnapshotRef.current && bonesById.size > 0) {
                        restoreThenEvaluatePoseClipPreview({ plan: next.plan, bonesById, snapshot: poseClipSnapshotRef.current, timeSeconds: next.currentTimeSeconds })
                      }
                      return { ...next, previewState: 'paused' }
                    })
                  }
                },
                onDeleteKeyframe: (keyframeId) => {
                  const summary = poseClipState.summary
                  if (summary?.hasRig) setPoseClipState((current) => reduceViewer3DPoseClipState(current, { type: 'delete-keyframe', summary, keyframeId }))
                },
                onUpdateSelectedKeyframe: handleUpdateSelectedPoseClipKeyframe,
                onDeleteSelectedKeyframe: handleDeleteSelectedPoseClipKeyframe,
                onMoveSelectedKeyframe: handleMoveSelectedPoseClipKeyframe,
                onShiftSelectedKeyframe: handleShiftSelectedPoseClipKeyframe,
                onDuplicateSelectedKeyframe: handleDuplicateSelectedPoseClipKeyframe,
                onPreviewPlay: handlePoseClipPreviewPlay,
                onPreviewPause: handlePoseClipPreviewPause,
                onPreviewReset: handlePoseClipPreviewReset,
                onRotateSelectedTarget: handleRotatePoseClipSelectedTarget,
                onResetSelectedTarget: handleResetPoseClipSelectedTarget,
                onSaveSidecar: handleSavePoseClipSidecar,
                onLoadSidecar: handleLoadPoseClipSidecar,
              }, rigEffectiveNaming)}
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