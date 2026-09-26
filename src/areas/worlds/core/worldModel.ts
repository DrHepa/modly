import type { WorldComponent } from './worldComponentRegistry.ts'

export const WORLD_PROJECT_SCHEMA = 'modly.world-project.v1' as const
export const WORLD_SCENE_SCHEMA = 'modly.world-scene.v1' as const
export const WORLD_COMMAND_BATCH_SCHEMA = 'modly.world-command-batch.v1' as const

export type WorldVector2 = [number, number]
export type WorldVector3 = [number, number, number]
export type WorldColor = `#${string}`

export interface WorldTransform {
  position: WorldVector3
  /** Euler angles in radians, applied in XYZ order. */
  rotation: WorldVector3
  scale: WorldVector3
}

interface WorldResourceBase {
  id: string
  name: string
  workspacePath: string
}

export interface WorldModelResource extends WorldResourceBase {
  type: 'model'
  format: 'glb' | 'gltf' | 'ply-mesh' | 'ply-points' | 'gaussian-ply'
}

export interface WorldAnimationResource extends WorldResourceBase {
  type: 'animation'
  format: 'pose-clip' | 'gltf-clip'
  sourceWorkspacePath?: string
  legacyWorkspacePath?: string
  clipId?: string
  clipName?: string
  /** gltf-clip only: loaded source order, not identity across source replacement. Older readers reject this field. */
  clipIndex?: number
  durationSeconds?: number
}

export interface WorldAudioResource extends WorldResourceBase {
  type: 'audio'
  format: 'wav' | 'mp3' | 'ogg' | 'flac'
}

export interface WorldEnvironmentResource extends WorldResourceBase {
  type: 'environment'
  format: 'hdr' | 'exr' | 'image'
}

export type WorldResource =
  | WorldModelResource
  | WorldAnimationResource
  | WorldAudioResource
  | WorldEnvironmentResource

export function isWorldGltfAnimationResourceBoundToModel(
  animation: WorldAnimationResource,
  model: WorldModelResource,
): boolean {
  if (animation.format !== 'gltf-clip' || (model.format !== 'glb' && model.format !== 'gltf')) return false
  return animation.workspacePath === model.workspacePath
    || animation.sourceWorkspacePath === model.workspacePath
}

export interface WorldSceneReference {
  id: string
  name: string
  documentPath: string
}

export type WorldInputValueType = 'button' | 'axis1d' | 'axis2d'
export type WorldInputDevice = 'keyboard' | 'mouse' | 'gamepad'

interface WorldInputBindingBase {
  device: WorldInputDevice
  control: string
  scale?: number
}

export type WorldInputBinding =
  | (WorldInputBindingBase & { kind: 'button' })
  | (WorldInputBindingBase & { kind: 'axis1d' })
  | (WorldInputBindingBase & { kind: 'axis2d'; targetAxis: 'x' | 'y' })

export interface WorldInputAction {
  id: string
  name: string
  valueType: WorldInputValueType
  bindings: WorldInputBinding[]
}

export interface WorldGraphicsProfile {
  id: string
  name: string
  renderScale: number
  shadowQuality: 'off' | 'low' | 'medium' | 'high'
  antialiasing: 'off' | 'fxaa' | 'msaa'
}

export interface WorldProjectDocumentV1 {
  schema: typeof WORLD_PROJECT_SCHEMA
  projectId: string
  name: string
  /** Monotonic document revision. Every accepted transaction advances it once. */
  revision: number
  resources: WorldResource[]
  scenes: WorldSceneReference[]
  startSceneId: string
  inputActions: WorldInputAction[]
  graphicsProfiles: WorldGraphicsProfile[]
  activeGraphicsProfileId: string
}

export interface WorldSceneInitialView {
  position: WorldVector3
  target: WorldVector3
  up?: WorldVector3
}

export interface WorldSceneEditorMetadata {
  initialView?: WorldSceneInitialView
}

export interface WorldSceneEnvironment {
  backgroundColor: WorldColor
  ambientIntensity: number
  environmentResourceId?: string
  fog?: {
    color: WorldColor
    near: number
    far: number
  }
}

export interface WorldEntity {
  id: string
  name: string
  parentId: string | null
  enabled: boolean
  locked: boolean
  tags: string[]
  transform: WorldTransform
  components: WorldComponent[]
}

export interface WorldRationalTime {
  numerator: number
  denominator: number
}

/**
 * Cubic v1 uses smoothstep t*t*(3-2*t) between adjacent numeric or vector
 * values. Authored tangents are deliberately not part of the v1 wire format.
 */
/**
 * Cubic v1 evaluates smoothstep s=t*t*(3-2*t) between adjacent keyframes in a
 * strictly time-ordered track. Values are numeric or vector and have no
 * authored tangents.
 */
export const WORLD_CUBIC_INTERPOLATION_SEMANTICS = 'smoothstep-adjacent-strictly-time-ordered-numeric-or-vector-values-no-authored-tangents' as const

interface WorldSequenceContinuousKeyframeBase {
  id: string
  time: WorldRationalTime
  interpolation?: 'step' | 'linear' | 'cubic'
}

interface WorldSequenceDiscreteKeyframeBase {
  id: string
  time: WorldRationalTime
  interpolation?: 'step'
}

export interface WorldTransformKeyframe extends WorldSequenceContinuousKeyframeBase {
  value: Partial<WorldTransform>
}

export interface WorldNumberKeyframe extends WorldSequenceContinuousKeyframeBase {
  value: number
}

export type WorldPropertyValue = string | number | boolean | WorldVector3

export type WorldPropertyKeyframe =
  | (WorldSequenceContinuousKeyframeBase & { value: number | WorldVector3 })
  | (WorldSequenceDiscreteKeyframeBase & { value: string | boolean })

export interface WorldBooleanKeyframe extends WorldSequenceDiscreteKeyframeBase {
  value: boolean
}

export interface WorldEventKeyframe extends WorldSequenceDiscreteKeyframeBase {
  eventId: string
}

export type WorldSequenceTrack =
  | { id: string; type: 'transform'; entityId: string; keyframes: WorldTransformKeyframe[] }
  | { id: string; type: 'camera'; entityId: string; keyframes: WorldBooleanKeyframe[] }
  | { id: string; type: 'animation'; entityId: string; componentId: string; keyframes: WorldBooleanKeyframe[] }
  | { id: string; type: 'light'; entityId: string; componentId: string; property: 'intensity'; keyframes: WorldNumberKeyframe[] }
  | { id: string; type: 'property'; entityId: string; componentId: string; property: string; keyframes: WorldPropertyKeyframe[] }
  | { id: string; type: 'audio'; entityId: string; componentId: string; keyframes: WorldBooleanKeyframe[] }
  | { id: string; type: 'event'; keyframes: WorldEventKeyframe[] }

export interface WorldSequence {
  id: string
  name: string
  duration: WorldRationalTime
  tracks: WorldSequenceTrack[]
}

export interface WorldSceneDocumentV1 {
  schema: typeof WORLD_SCENE_SCHEMA
  projectId: string
  sceneId: string
  name: string
  environment: WorldSceneEnvironment
  editor?: WorldSceneEditorMetadata
  entities: WorldEntity[]
  sequences: WorldSequence[]
}

export interface WorldProjectSnapshotV1 {
  project: WorldProjectDocumentV1
  scenes: WorldSceneDocumentV1[]
}
