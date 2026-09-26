import type { WorldAnimationResource, WorldColor, WorldModelResource, WorldVector2, WorldVector3 } from './worldModel.ts'
import {
  isWorldCanonicalId,
  isWorldCanonicalPropertyName,
  WORLD_MAX_COLLECTION_ITEMS,
  WORLD_MAX_RECORD_KEYS,
} from './worldValidationLimits.ts'
import { isSafeWorldWireRecord, normalizeWorldWireValue } from './worldWireValidation.ts'

export const WORLD_COMPONENT_TYPES = Object.freeze([
  'renderable',
  'camera',
  'light',
  'environment',
  'collider',
  'rigid-body',
  'character-controller',
  'animation-player',
  'audio-source',
  'audio-listener',
  'trigger',
  'behavior',
] as const)

export type WorldComponentType = typeof WORLD_COMPONENT_TYPES[number]
export type WorldComponentCardinality = 'one' | 'many'
export type WorldComponentEditorSection = 'Rendering' | 'Camera' | 'Lighting' | 'Environment' | 'Physics' | 'Animation' | 'Audio' | 'Logic'
export type WorldInspectorControlKind =
  | 'text'
  | 'toggle'
  | 'number'
  | 'color'
  | 'select'
  | 'resource'
  | 'component'
  | 'input-action'
  | 'tags'
  | 'vector2'
  | 'vector3'
  | 'triangle2d'
  | 'behavior-list'
export type WorldInspectorUnit = 'meters' | 'degrees' | 'radians' | 'seconds' | 'multiplier' | 'normalized' | 'bitmask'
export type WorldInspectorOptionValue = string | number | boolean

export type WorldInspectorFieldCondition =
  | { property: string; equals: WorldInspectorOptionValue }
  | { property: string; oneOf: readonly WorldInspectorOptionValue[] }

export interface WorldInspectorFieldDescriptor {
  property: string
  label: string
  control: WorldInspectorControlKind
  unit?: WorldInspectorUnit
  min?: number
  max?: number
  step?: number
  options?: readonly { value: WorldInspectorOptionValue; label: string }[]
  visibleWhen?: WorldInspectorFieldCondition
}

interface WorldComponentBase {
  id: string
  type: WorldComponentType
  enabled: boolean
}

export interface WorldRenderableComponent extends WorldComponentBase {
  type: 'renderable'
  resourceId: string
  visible: boolean
  castShadow: boolean
  receiveShadow: boolean
  material: {
    baseColor: WorldColor
    metallic: number
    roughness: number
    opacity: number
  }
}

export interface WorldCameraComponent extends WorldComponentBase {
  type: 'camera'
  projection: 'perspective' | 'orthographic'
  primary: boolean
  near: number
  far: number
  fieldOfView?: number
  /** Full vertical camera extent in world-space units. */
  orthographicSize?: number
}

interface WorldLightComponentBase extends WorldComponentBase {
  type: 'light'
  color: WorldColor
  intensity: number
}

export type WorldLightComponent = WorldLightComponentBase & (
  | { lightKind: 'ambient' }
  | { lightKind: 'directional'; castShadow: boolean }
  | { lightKind: 'point'; range: number; castShadow: boolean }
  | { lightKind: 'spot'; range: number; angle: number; castShadow: boolean }
)

/** Parsed for registry completeness, but rejected on entities by document validation. */
export interface WorldEnvironmentComponent extends WorldComponentBase {
  type: 'environment'
  backgroundColor: WorldColor
  ambientIntensity: number
  resourceId?: string
}

interface WorldColliderBase extends WorldComponentBase {
  type: 'collider'
  purpose: 'simulation' | 'editor-navigation'
  sensor: boolean
  friction: number
  restitution: number
  /** Rapier v1 interaction-group membership/filter halves; each is exactly 16-bit. */
  collisionLayer?: number
  collisionMask?: number
}

export type WorldColliderComponent = WorldColliderBase & (
  | { shape: 'box'; halfExtents: WorldVector3 }
  | { shape: 'sphere'; radius: number }
  | { shape: 'capsule'; radius: number; halfHeight: number }
  | { shape: 'convex' | 'mesh'; resourceId: string }
  | { shape: 'rect-surface'; halfExtents: WorldVector2; sidedness: 'front' | 'double'; legacyPreset?: Exclude<WorldLegacyCollisionSurfacePreset, 'triangle'> }
  | { shape: 'tri-surface'; vertices: [WorldVector2, WorldVector2, WorldVector2]; sidedness: 'front' | 'double'; legacyPreset?: Extract<WorldLegacyCollisionSurfacePreset, 'triangle'> }
)

export type WorldLegacyCollisionSurfacePreset = 'rectangle' | 'square' | 'triangle' | 'wall' | 'floor' | 'ramp'

export interface WorldRigidBodyComponent extends WorldComponentBase {
  type: 'rigid-body'
  bodyType: 'fixed' | 'dynamic' | 'kinematic-position' | 'kinematic-velocity'
  gravityScale: number
  linearDamping: number
  angularDamping: number
  canSleep: boolean
}

export interface WorldCharacterControllerComponent extends WorldComponentBase {
  type: 'character-controller'
  colliderComponentId: string
  moveActionId: string
  jumpActionId?: string
  speed: number
  jumpSpeed: number
  maxSlopeDegrees: number
}

export interface WorldAnimationPlayerComponent extends WorldComponentBase {
  type: 'animation-player'
  resourceId: string
  autoplay: boolean
  loop: boolean
  speed: number
}

export interface WorldAudioSourceComponent extends WorldComponentBase {
  type: 'audio-source'
  resourceId: string
  autoplay: boolean
  loop: boolean
  volume: number
  spatial: boolean
  maxDistance: number
}

export interface WorldAudioListenerComponent extends WorldComponentBase {
  type: 'audio-listener'
  primary: boolean
}

export interface WorldTriggerComponent extends WorldComponentBase {
  type: 'trigger'
  colliderComponentId: string
  once: boolean
  targetTags: string[]
}

export type WorldBehaviorEvent =
  | { type: 'start' }
  | { type: 'input'; actionId: string; phase: 'pressed' | 'released' | 'held' }
  | { type: 'trigger-enter' | 'trigger-exit'; triggerComponentId: string }
  | { type: 'timer'; delaySeconds: number; repeat: boolean }
  | { type: 'sequence-event'; sequenceId: string; eventId: string }

export type WorldWritableValue = string | number | boolean | WorldVector3

export type WorldBehaviorAction =
  | { type: 'set-visibility'; entityId: string; visible: boolean }
  | { type: 'set-component-property'; entityId: string; componentId: string; componentType: WorldComponentType; property: string; value: WorldWritableValue }
  | { type: 'play-animation'; entityId: string; componentId: string }
  | { type: 'play-audio'; entityId: string; componentId: string }
  | { type: 'stop-audio'; entityId: string; componentId: string }
  | { type: 'apply-impulse'; entityId: string; impulse: WorldVector3 }
  | { type: 'change-scene'; sceneId: string }

export interface WorldBehaviorBinding {
  id: string
  event: WorldBehaviorEvent
  actions: WorldBehaviorAction[]
}

export interface WorldBehaviorComponent extends WorldComponentBase {
  type: 'behavior'
  bindings: WorldBehaviorBinding[]
}

export type WorldComponent =
  | WorldRenderableComponent
  | WorldCameraComponent
  | WorldLightComponent
  | WorldEnvironmentComponent
  | WorldColliderComponent
  | WorldRigidBodyComponent
  | WorldCharacterControllerComponent
  | WorldAnimationPlayerComponent
  | WorldAudioSourceComponent
  | WorldAudioListenerComponent
  | WorldTriggerComponent
  | WorldBehaviorComponent

export interface WorldComponentDefinition {
  type: WorldComponentType
  cardinality: WorldComponentCardinality
  entityAllowed: boolean
  label: string
  editorSection: WorldComponentEditorSection
  runtimeAuthority: WorldComponentRuntimeAuthority
  writableProperties: readonly string[]
  livePropertyCapabilities: readonly WorldLivePropertyCapability[]
  inspectorFields: readonly WorldInspectorFieldDescriptor[]
  createDefault: (id: string) => WorldComponent
}

export type WorldComponentRuntimeAuthority = 'presentation' | 'physics' | 'audio' | 'behavior'

export interface WorldLivePropertyCapability {
  property: string
  modelFormats?: readonly WorldModelResource['format'][]
  animationFormats?: readonly WorldAnimationResource['format'][]
}

export interface WorldLivePropertyContext {
  modelFormat?: WorldModelResource['format']
  animationFormat?: WorldAnimationResource['format']
}

export interface WorldComponentReference {
  kind: 'resource' | 'entity' | 'component' | 'scene' | 'input-action' | 'sequence'
  id: string
  path: string
  resourceType?: 'model' | 'animation' | 'audio' | 'environment'
}

export interface WorldComponentIssue {
  code: string
  path: string
  message: string
}

export type ParseWorldComponentResult =
  | { success: true; value: WorldComponent }
  | { success: false; issues: WorldComponentIssue[] }

const ENABLED_FIELD: WorldInspectorFieldDescriptor = { property: 'enabled', label: 'Enabled', control: 'toggle' }

function defineComponent(definition: WorldComponentDefinition): WorldComponentDefinition {
  return Object.freeze({
    ...definition,
    writableProperties: Object.freeze([...definition.writableProperties]),
    livePropertyCapabilities: Object.freeze(definition.livePropertyCapabilities.map((capability) => Object.freeze({
      ...capability,
      ...(capability.modelFormats ? { modelFormats: Object.freeze([...capability.modelFormats]) } : {}),
      ...(capability.animationFormats ? { animationFormats: Object.freeze([...capability.animationFormats]) } : {}),
    }))),
    inspectorFields: Object.freeze(definition.inspectorFields.map((field) => Object.freeze({ ...field }))),
  })
}

const ALL_MODEL_FORMATS: readonly WorldModelResource['format'][] = ['glb', 'gltf', 'ply-mesh', 'ply-points', 'gaussian-ply']
const GLTF_MODEL_FORMATS: readonly WorldModelResource['format'][] = ['glb', 'gltf']
const MESH_MODEL_FORMATS: readonly WorldModelResource['format'][] = ['glb', 'gltf', 'ply-mesh']

function liveProperties(...properties: string[]): WorldLivePropertyCapability[] {
  return properties.map((property) => ({ property }))
}

function liveModelProperties(modelFormats: readonly WorldModelResource['format'][], ...properties: string[]): WorldLivePropertyCapability[] {
  return properties.map((property) => ({ property, modelFormats }))
}

const DEFINITIONS: readonly WorldComponentDefinition[] = Object.freeze([
  defineComponent({
    type: 'renderable', cardinality: 'one', entityAllowed: true, label: 'Renderable', editorSection: 'Rendering',
    runtimeAuthority: 'presentation',
    writableProperties: ['enabled', 'visible', 'castShadow', 'receiveShadow', 'material.baseColor', 'material.metallic', 'material.roughness', 'material.opacity'],
    livePropertyCapabilities: [
      ...liveModelProperties(ALL_MODEL_FORMATS, 'enabled', 'visible'),
      ...liveModelProperties(MESH_MODEL_FORMATS, 'castShadow', 'receiveShadow', 'material.metallic', 'material.roughness', 'material.opacity'),
      ...liveModelProperties(GLTF_MODEL_FORMATS, 'material.baseColor'),
    ],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'resourceId', label: 'Model', control: 'resource' },
      { property: 'visible', label: 'Visible', control: 'toggle' },
      { property: 'castShadow', label: 'Cast shadow', control: 'toggle' },
      { property: 'receiveShadow', label: 'Receive shadow', control: 'toggle' },
      { property: 'material.baseColor', label: 'Base color', control: 'color' },
      { property: 'material.metallic', label: 'Metallic', control: 'number', unit: 'normalized', min: 0, max: 1, step: 0.01 },
      { property: 'material.roughness', label: 'Roughness', control: 'number', unit: 'normalized', min: 0, max: 1, step: 0.01 },
      { property: 'material.opacity', label: 'Opacity', control: 'number', unit: 'normalized', min: 0, max: 1, step: 0.01 },
    ],
    createDefault: (id) => createDefaultWorldComponent('renderable', id),
  }),
  defineComponent({
    type: 'camera', cardinality: 'one', entityAllowed: true, label: 'Camera', editorSection: 'Camera',
    runtimeAuthority: 'presentation',
    writableProperties: ['enabled', 'primary', 'near', 'far', 'fieldOfView', 'orthographicSize'],
    livePropertyCapabilities: liveProperties('enabled', 'primary', 'near', 'far', 'fieldOfView', 'orthographicSize'),
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'projection', label: 'Projection', control: 'select', options: [{ value: 'perspective', label: 'Perspective' }, { value: 'orthographic', label: 'Orthographic' }] },
      { property: 'primary', label: 'Primary', control: 'toggle' },
      { property: 'near', label: 'Near', control: 'number', unit: 'meters', min: 0.001, step: 0.01 },
      { property: 'far', label: 'Far', control: 'number', unit: 'meters', min: 0.01, step: 1 },
      { property: 'fieldOfView', label: 'Field of view', control: 'number', unit: 'degrees', min: 1, max: 179, step: 1, visibleWhen: { property: 'projection', equals: 'perspective' } },
      { property: 'orthographicSize', label: 'Size', control: 'number', unit: 'meters', min: 0.01, step: 0.1, visibleWhen: { property: 'projection', equals: 'orthographic' } },
    ],
    createDefault: (id) => createDefaultWorldComponent('camera', id),
  }),
  defineComponent({
    type: 'light', cardinality: 'one', entityAllowed: true, label: 'Light', editorSection: 'Lighting',
    runtimeAuthority: 'presentation',
    writableProperties: ['enabled', 'color', 'intensity', 'range', 'angle', 'castShadow'],
    livePropertyCapabilities: liveProperties('enabled', 'color', 'intensity', 'range', 'angle', 'castShadow'),
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'lightKind', label: 'Kind', control: 'select', options: [{ value: 'ambient', label: 'Ambient' }, { value: 'directional', label: 'Directional' }, { value: 'point', label: 'Point' }, { value: 'spot', label: 'Spot' }] },
      { property: 'color', label: 'Color', control: 'color' },
      { property: 'intensity', label: 'Intensity', control: 'number', min: 0, step: 0.1 },
      { property: 'castShadow', label: 'Cast shadow', control: 'toggle', visibleWhen: { property: 'lightKind', oneOf: ['directional', 'point', 'spot'] } },
      { property: 'range', label: 'Range', control: 'number', unit: 'meters', min: 0.01, step: 0.1, visibleWhen: { property: 'lightKind', oneOf: ['point', 'spot'] } },
      { property: 'angle', label: 'Angle', control: 'number', unit: 'radians', min: 0.01, max: Math.PI, step: 0.01, visibleWhen: { property: 'lightKind', equals: 'spot' } },
    ],
    createDefault: (id) => createDefaultWorldComponent('light', id),
  }),
  defineComponent({
    type: 'environment', cardinality: 'one', entityAllowed: false, label: 'Environment', editorSection: 'Environment',
    runtimeAuthority: 'presentation',
    writableProperties: ['enabled', 'backgroundColor', 'ambientIntensity'],
    livePropertyCapabilities: liveProperties('enabled', 'backgroundColor', 'ambientIntensity'),
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'backgroundColor', label: 'Background', control: 'color' },
      { property: 'ambientIntensity', label: 'Ambient', control: 'number', min: 0, step: 0.1 },
      { property: 'resourceId', label: 'Environment map', control: 'resource' },
    ],
    createDefault: (id) => createDefaultWorldComponent('environment', id),
  }),
  defineComponent({
    type: 'collider', cardinality: 'many', entityAllowed: true, label: 'Collider', editorSection: 'Physics',
    runtimeAuthority: 'physics',
    writableProperties: ['enabled', 'sensor', 'friction', 'restitution', 'collisionLayer', 'collisionMask'],
    livePropertyCapabilities: [],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'purpose', label: 'Purpose', control: 'select', options: [{ value: 'simulation', label: 'Simulation' }, { value: 'editor-navigation', label: 'Editor navigation' }] },
      { property: 'shape', label: 'Shape', control: 'select', options: [{ value: 'box', label: 'Box' }, { value: 'sphere', label: 'Sphere' }, { value: 'capsule', label: 'Capsule' }, { value: 'convex', label: 'Convex' }, { value: 'mesh', label: 'Mesh' }, { value: 'rect-surface', label: 'Rectangle surface' }, { value: 'tri-surface', label: 'Triangle surface' }] },
      { property: 'sensor', label: 'Sensor', control: 'toggle' },
      { property: 'friction', label: 'Friction', control: 'number', min: 0, step: 0.01 },
      { property: 'restitution', label: 'Restitution', control: 'number', unit: 'normalized', min: 0, max: 1, step: 0.01 },
      { property: 'collisionLayer', label: 'Layer', control: 'number', unit: 'bitmask', min: 0, max: 0xffff, step: 1 },
      { property: 'collisionMask', label: 'Mask', control: 'number', unit: 'bitmask', min: 0, max: 0xffff, step: 1 },
      { property: 'halfExtents', label: 'Half extents', control: 'vector3', unit: 'meters', visibleWhen: { property: 'shape', equals: 'box' } },
      { property: 'radius', label: 'Radius', control: 'number', unit: 'meters', min: 0.001, step: 0.01, visibleWhen: { property: 'shape', oneOf: ['sphere', 'capsule'] } },
      { property: 'halfHeight', label: 'Half height', control: 'number', unit: 'meters', min: 0.001, step: 0.01, visibleWhen: { property: 'shape', equals: 'capsule' } },
      { property: 'resourceId', label: 'Geometry', control: 'resource', visibleWhen: { property: 'shape', oneOf: ['convex', 'mesh'] } },
      { property: 'halfExtents', label: 'Half extents', control: 'vector2', unit: 'meters', visibleWhen: { property: 'shape', equals: 'rect-surface' } },
      { property: 'vertices', label: 'Vertices', control: 'triangle2d', unit: 'meters', visibleWhen: { property: 'shape', equals: 'tri-surface' } },
      { property: 'sidedness', label: 'Sidedness', control: 'select', options: [{ value: 'front', label: 'Front' }, { value: 'double', label: 'Double' }], visibleWhen: { property: 'shape', oneOf: ['rect-surface', 'tri-surface'] } },
      { property: 'legacyPreset', label: 'Preset', control: 'select', options: [{ value: 'rectangle', label: 'Rectangle' }, { value: 'square', label: 'Square' }, { value: 'wall', label: 'Wall' }, { value: 'floor', label: 'Floor' }, { value: 'ramp', label: 'Ramp' }], visibleWhen: { property: 'shape', equals: 'rect-surface' } },
      { property: 'legacyPreset', label: 'Preset', control: 'select', options: [{ value: 'triangle', label: 'Triangle' }], visibleWhen: { property: 'shape', equals: 'tri-surface' } },
    ],
    createDefault: (id) => createDefaultWorldComponent('collider', id),
  }),
  defineComponent({
    type: 'rigid-body', cardinality: 'one', entityAllowed: true, label: 'Rigid body', editorSection: 'Physics',
    runtimeAuthority: 'physics',
    writableProperties: ['enabled', 'gravityScale', 'linearDamping', 'angularDamping', 'canSleep'],
    livePropertyCapabilities: [],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'bodyType', label: 'Body type', control: 'select', options: [{ value: 'fixed', label: 'Fixed' }, { value: 'dynamic', label: 'Dynamic' }, { value: 'kinematic-position', label: 'Kinematic position' }, { value: 'kinematic-velocity', label: 'Kinematic velocity' }] },
      { property: 'gravityScale', label: 'Gravity scale', control: 'number', unit: 'multiplier', step: 0.1, visibleWhen: { property: 'bodyType', equals: 'dynamic' } },
      { property: 'linearDamping', label: 'Linear damping', control: 'number', min: 0, step: 0.01, visibleWhen: { property: 'bodyType', oneOf: ['dynamic', 'kinematic-position', 'kinematic-velocity'] } },
      { property: 'angularDamping', label: 'Angular damping', control: 'number', min: 0, step: 0.01, visibleWhen: { property: 'bodyType', oneOf: ['dynamic', 'kinematic-position', 'kinematic-velocity'] } },
      { property: 'canSleep', label: 'Can sleep', control: 'toggle', visibleWhen: { property: 'bodyType', oneOf: ['dynamic', 'kinematic-position', 'kinematic-velocity'] } },
    ],
    createDefault: (id) => createDefaultWorldComponent('rigid-body', id),
  }),
  defineComponent({
    type: 'character-controller', cardinality: 'one', entityAllowed: true, label: 'Character controller', editorSection: 'Physics',
    runtimeAuthority: 'physics',
    writableProperties: ['enabled', 'speed', 'jumpSpeed', 'maxSlopeDegrees'],
    livePropertyCapabilities: [],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'colliderComponentId', label: 'Collider', control: 'component' },
      { property: 'moveActionId', label: 'Move action', control: 'input-action' },
      { property: 'jumpActionId', label: 'Jump action', control: 'input-action' },
      { property: 'speed', label: 'Speed', control: 'number', unit: 'meters', min: 0, step: 0.1 },
      { property: 'jumpSpeed', label: 'Jump speed', control: 'number', unit: 'meters', min: 0, step: 0.1 },
      { property: 'maxSlopeDegrees', label: 'Max slope', control: 'number', unit: 'degrees', min: 0, max: 90, step: 1 },
    ],
    createDefault: (id) => createDefaultWorldComponent('character-controller', id),
  }),
  defineComponent({
    type: 'animation-player', cardinality: 'one', entityAllowed: true, label: 'Animation player', editorSection: 'Animation',
    runtimeAuthority: 'presentation',
    writableProperties: ['enabled', 'autoplay', 'loop', 'speed'],
    livePropertyCapabilities: [],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'resourceId', label: 'Animation', control: 'resource' },
      { property: 'autoplay', label: 'Autoplay', control: 'toggle' },
      { property: 'loop', label: 'Loop', control: 'toggle' },
      { property: 'speed', label: 'Speed', control: 'number', unit: 'multiplier', step: 0.1 },
    ],
    createDefault: (id) => createDefaultWorldComponent('animation-player', id),
  }),
  defineComponent({
    type: 'audio-source', cardinality: 'many', entityAllowed: true, label: 'Audio source', editorSection: 'Audio',
    runtimeAuthority: 'audio',
    writableProperties: ['enabled', 'autoplay', 'loop', 'volume', 'spatial', 'maxDistance'],
    livePropertyCapabilities: [],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'resourceId', label: 'Audio', control: 'resource' },
      { property: 'autoplay', label: 'Autoplay', control: 'toggle' },
      { property: 'loop', label: 'Loop', control: 'toggle' },
      { property: 'volume', label: 'Volume', control: 'number', unit: 'normalized', min: 0, max: 1, step: 0.01 },
      { property: 'spatial', label: 'Spatial', control: 'toggle' },
      { property: 'maxDistance', label: 'Max distance', control: 'number', unit: 'meters', min: 0.01, step: 0.1, visibleWhen: { property: 'spatial', equals: true } },
    ],
    createDefault: (id) => createDefaultWorldComponent('audio-source', id),
  }),
  defineComponent({
    type: 'audio-listener', cardinality: 'one', entityAllowed: true, label: 'Audio listener', editorSection: 'Audio',
    runtimeAuthority: 'audio',
    writableProperties: ['enabled', 'primary'],
    livePropertyCapabilities: [],
    inspectorFields: [ENABLED_FIELD, { property: 'primary', label: 'Primary', control: 'toggle' }],
    createDefault: (id) => createDefaultWorldComponent('audio-listener', id),
  }),
  defineComponent({
    type: 'trigger', cardinality: 'many', entityAllowed: true, label: 'Trigger', editorSection: 'Logic',
    runtimeAuthority: 'behavior',
    writableProperties: ['enabled', 'once'],
    livePropertyCapabilities: [],
    inspectorFields: [
      ENABLED_FIELD,
      { property: 'colliderComponentId', label: 'Collider', control: 'component' },
      { property: 'once', label: 'Once', control: 'toggle' },
      { property: 'targetTags', label: 'Target tags', control: 'tags' },
    ],
    createDefault: (id) => createDefaultWorldComponent('trigger', id),
  }),
  defineComponent({
    type: 'behavior', cardinality: 'many', entityAllowed: true, label: 'Behavior', editorSection: 'Logic',
    runtimeAuthority: 'behavior',
    writableProperties: ['enabled'],
    livePropertyCapabilities: [],
    inspectorFields: [ENABLED_FIELD, { property: 'bindings', label: 'Bindings', control: 'behavior-list' }],
    createDefault: (id) => createDefaultWorldComponent('behavior', id),
  }),
])

const DEFINITIONS_BY_TYPE = new Map(DEFINITIONS.map((definition) => [definition.type, definition]))

export function getWorldComponentDefinition(type: string): WorldComponentDefinition | undefined {
  return isWorldComponentType(type) ? DEFINITIONS_BY_TYPE.get(type) : undefined
}

export function createDefaultWorldComponent<TType extends WorldComponentType>(type: TType, id: string): Extract<WorldComponent, { type: TType }>
export function createDefaultWorldComponent(type: WorldComponentType, id: string): WorldComponent
export function createDefaultWorldComponent(type: WorldComponentType, id: string): WorldComponent {
  if (!isWorldCanonicalId(id)) throw new RangeError('Default component id must be a canonical id of at most 256 characters.')
  switch (type) {
    case 'renderable': return {
      id, type, enabled: true, resourceId: 'resource:model', visible: true, castShadow: true, receiveShadow: true,
      material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
    }
    case 'camera': return { id, type, enabled: true, projection: 'perspective', primary: false, near: 0.1, far: 1_000, fieldOfView: 60 }
    case 'light': return { id, type, enabled: true, lightKind: 'directional', color: '#ffffff', intensity: 1, castShadow: true }
    case 'environment': return { id, type, enabled: true, backgroundColor: '#20242b', ambientIntensity: 0.35 }
    case 'collider': return {
      id, type, enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.5, 0.5, 0.5], sensor: false,
      friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff,
    }
    case 'rigid-body': return { id, type, enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true }
    case 'character-controller': return {
      id, type, enabled: true, colliderComponentId: 'component:collider', moveActionId: 'input:move', jumpActionId: 'input:jump',
      speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45,
    }
    case 'animation-player': return { id, type, enabled: true, resourceId: 'resource:animation', autoplay: false, loop: true, speed: 1 }
    case 'audio-source': return { id, type, enabled: true, resourceId: 'resource:audio', autoplay: false, loop: false, volume: 1, spatial: true, maxDistance: 20 }
    case 'audio-listener': return { id, type, enabled: true, primary: false }
    case 'trigger': return { id, type, enabled: true, colliderComponentId: 'component:collider', once: false, targetTags: [] }
    case 'behavior': return { id, type, enabled: true, bindings: [] }
  }
}

export function parseWorldComponent(value: unknown, path = 'component'): ParseWorldComponentResult {
  const wire = normalizeWorldWireValue(value, path)
  if (!wire.success) return { success: false, issues: wire.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })) }
  value = wire.value
  if (!isRecord(value)) return failure(path, 'type', 'Component must be an object.')
  const base = parseBase(value)
  if (!base) return failure(path, 'base', 'Component id, type, and enabled are invalid.')

  switch (base.type) {
    case 'renderable': return parseRenderable(value, base, path)
    case 'camera': return parseCamera(value, base, path)
    case 'light': return parseLight(value, base, path)
    case 'environment': return parseEnvironment(value, base, path)
    case 'collider': return parseCollider(value, base, path)
    case 'rigid-body': return parseRigidBody(value, base, path)
    case 'character-controller': return parseCharacterController(value, base, path)
    case 'animation-player': return parseAnimationPlayer(value, base, path)
    case 'audio-source': return parseAudioSource(value, base, path)
    case 'audio-listener': return parseAudioListener(value, base, path)
    case 'trigger': return parseTrigger(value, base, path)
    case 'behavior': return parseBehavior(value, base, path)
  }
}

export function collectWorldComponentReferences(component: WorldComponent): WorldComponentReference[] {
  const references: WorldComponentReference[] = []
  const add = (reference: WorldComponentReference) => references.push(reference)
  if (component.type === 'renderable') add({ kind: 'resource', resourceType: 'model', id: component.resourceId, path: 'resourceId' })
  if (component.type === 'environment' && component.resourceId) add({ kind: 'resource', resourceType: 'environment', id: component.resourceId, path: 'resourceId' })
  if (component.type === 'collider' && (component.shape === 'convex' || component.shape === 'mesh')) add({ kind: 'resource', resourceType: 'model', id: component.resourceId, path: 'resourceId' })
  if (component.type === 'character-controller') {
    add({ kind: 'component', id: component.colliderComponentId, path: 'colliderComponentId' })
    add({ kind: 'input-action', id: component.moveActionId, path: 'moveActionId' })
    if (component.jumpActionId) add({ kind: 'input-action', id: component.jumpActionId, path: 'jumpActionId' })
  }
  if (component.type === 'animation-player') add({ kind: 'resource', resourceType: 'animation', id: component.resourceId, path: 'resourceId' })
  if (component.type === 'audio-source') add({ kind: 'resource', resourceType: 'audio', id: component.resourceId, path: 'resourceId' })
  if (component.type === 'trigger') add({ kind: 'component', id: component.colliderComponentId, path: 'colliderComponentId' })
  if (component.type === 'behavior') collectBehaviorReferences(component, add)
  return references.sort(compareReference)
}

export function isWorldComponentPropertyWritable(type: string, property: string, value: unknown): boolean {
  const definition = getWorldComponentDefinition(type)
  if (!definition?.writableProperties.includes(property)) return false
  const key = `${type}:${property}`
  if (BOOLEAN_WRITABLE_PROPERTIES.has(key)) return typeof value === 'boolean'
  if (COLOR_WRITABLE_PROPERTIES.has(key)) return parseColor(value) !== null

  switch (key) {
    case 'renderable:material.metallic':
    case 'renderable:material.roughness':
    case 'renderable:material.opacity':
    case 'collider:restitution':
    case 'audio-source:volume':
      return rangedNumber(value, 0, 1) !== null
    case 'camera:fieldOfView':
      return inOpenRange(value, 0, 180)
    case 'light:angle':
      return inOpenRange(value, 0, Math.PI)
    case 'camera:near':
    case 'camera:far':
    case 'camera:orthographicSize':
    case 'light:range':
    case 'audio-source:maxDistance':
      return positiveNumber(value) !== null
    case 'light:intensity':
    case 'environment:ambientIntensity':
    case 'collider:friction':
    case 'rigid-body:linearDamping':
    case 'rigid-body:angularDamping':
    case 'character-controller:speed':
    case 'character-controller:jumpSpeed':
      return nonNegativeNumber(value) !== null
    case 'character-controller:maxSlopeDegrees':
      return rangedNumber(value, 0, 90) !== null
    case 'collider:collisionLayer':
    case 'collider:collisionMask':
      return unsigned16(value) !== null
    case 'rigid-body:gravityScale':
      return finiteNumber(value) !== null
    case 'animation-player:speed': {
      const speed = finiteNumber(value)
      return speed !== null && speed !== 0
    }
    default:
      return false
  }
}

export function isWorldComponentPropertyWritableFor(component: WorldComponent, property: string, value: unknown): boolean {
  if (!isWorldComponentPropertyWritable(component.type, property, value)) return false
  if (component.type === 'camera') {
    if (property === 'fieldOfView' && component.projection !== 'perspective') return false
    if (property === 'orthographicSize' && component.projection !== 'orthographic') return false
    if (property === 'near' && typeof value === 'number' && value >= component.far) return false
    if (property === 'far' && typeof value === 'number' && value <= component.near) return false
  }
  if (component.type === 'light') {
    if (property === 'range' && component.lightKind !== 'point' && component.lightKind !== 'spot') return false
    if (property === 'angle' && component.lightKind !== 'spot') return false
    if (property === 'castShadow' && component.lightKind === 'ambient') return false
  }
  return true
}

export function getWorldComponentPropertyRuntimeAuthority(
  component: WorldComponent,
  property: string,
  value: unknown,
): WorldComponentRuntimeAuthority | undefined {
  if (!isWorldComponentPropertyWritableFor(component, property, value)) return undefined
  return getWorldComponentDefinition(component.type)?.runtimeAuthority
}

export function isWorldComponentPropertyLiveInPlay(
  component: WorldComponent,
  property: string,
  value: unknown,
  context: WorldLivePropertyContext = {},
): boolean {
  if (!isWorldComponentPropertyWritableFor(component, property, value)) return false
  const capability = getWorldComponentDefinition(component.type)?.livePropertyCapabilities
    .find((candidate) => candidate.property === property)
  if (!capability) return false
  if (capability.modelFormats && (!context.modelFormat || !capability.modelFormats.includes(context.modelFormat))) return false
  if (capability.animationFormats && (!context.animationFormat || !capability.animationFormats.includes(context.animationFormat))) return false
  return true
}

export function validateWorldInspectorFieldValue(component: WorldComponent, property: string, value: unknown): boolean {
  const definition = getWorldComponentDefinition(component.type)
  if (!definition?.inspectorFields.some((field) => field.property === property)) return false
  return isWorldComponentPropertyWritableFor(component, property, value)
}

const BOOLEAN_WRITABLE_PROPERTIES = new Set([
  'renderable:enabled',
  'renderable:visible',
  'renderable:castShadow',
  'renderable:receiveShadow',
  'camera:enabled',
  'camera:primary',
  'light:enabled',
  'light:castShadow',
  'environment:enabled',
  'collider:enabled',
  'collider:sensor',
  'rigid-body:enabled',
  'rigid-body:canSleep',
  'character-controller:enabled',
  'animation-player:enabled',
  'animation-player:autoplay',
  'animation-player:loop',
  'audio-source:enabled',
  'audio-source:autoplay',
  'audio-source:loop',
  'audio-source:spatial',
  'audio-listener:enabled',
  'audio-listener:primary',
  'trigger:enabled',
  'trigger:once',
  'behavior:enabled',
])

const COLOR_WRITABLE_PROPERTIES = new Set([
  'renderable:material.baseColor',
  'light:color',
  'environment:backgroundColor',
])

export interface WorldComponentSafeDescription {
  id: string
  type: WorldComponentType
  enabled: boolean
  label: string
  editorSection: WorldComponentEditorSection
  allowedFields: string[]
  references: { kind: WorldComponentReference['kind']; id: string }[]
}

export function describeWorldComponentForEditor(component: WorldComponent): WorldComponentSafeDescription {
  const parsed = parseWorldComponent(component)
  if (!parsed.success) throw new TypeError('Safe component descriptions require a canonical component.')
  const canonicalComponent = parsed.value
  const definition = getWorldComponentDefinition(canonicalComponent.type)
  if (!definition) throw new Error(`Missing registry definition for ${canonicalComponent.type}.`)
  return {
    id: canonicalComponent.id,
    type: canonicalComponent.type,
    enabled: canonicalComponent.enabled,
    label: definition.label,
    editorSection: definition.editorSection,
    allowedFields: [...definition.writableProperties],
    references: collectWorldComponentReferences(canonicalComponent).map((reference) => ({ kind: reference.kind, id: reference.id })),
  }
}

export function describeWorldComponentForAi(component: WorldComponent): WorldComponentSafeDescription {
  return describeWorldComponentForEditor(component)
}

type ParsedBase = { id: string; type: WorldComponentType; enabled: boolean }

function parseBase(value: Record<string, unknown>): ParsedBase | null {
  const id = canonicalId(value.id)
  if (!id || typeof value.enabled !== 'boolean' || !isWorldComponentType(value.type)) return null
  return { id, type: value.type, enabled: value.enabled }
}

function parseRenderable(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'resourceId', 'visible', 'castShadow', 'receiveShadow', 'material'])) return failure(path, 'unknown-property', 'Renderable contains an unsupported property.')
  const resourceId = canonicalId(value.resourceId)
  const material = parseMaterial(value.material)
  if (!resourceId || typeof value.visible !== 'boolean' || typeof value.castShadow !== 'boolean' || typeof value.receiveShadow !== 'boolean' || !material) return failure(path, 'renderable', 'Renderable properties are invalid.')
  return success({ ...base, type: 'renderable', resourceId, visible: value.visible, castShadow: value.castShadow, receiveShadow: value.receiveShadow, material })
}

function parseCamera(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'projection', 'primary', 'near', 'far', 'fieldOfView', 'orthographicSize'])) return failure(path, 'unknown-property', 'Camera contains an unsupported property.')
  if ((value.projection !== 'perspective' && value.projection !== 'orthographic') || typeof value.primary !== 'boolean') return failure(path, 'camera', 'Camera projection or primary flag is invalid.')
  const near = positiveNumber(value.near)
  const far = positiveNumber(value.far)
  if (near === null || far === null || far <= near) return failure(path, 'camera-clipping', 'Camera clipping planes are invalid.')
  if (value.projection === 'perspective') {
    const fieldOfView = positiveNumber(value.fieldOfView)
    if (fieldOfView === null || fieldOfView >= 180 || value.orthographicSize !== undefined) return failure(path, 'camera-perspective', 'Perspective camera field of view is invalid.')
    return success({ ...base, type: 'camera', projection: 'perspective', primary: value.primary, near, far, fieldOfView })
  }
  const orthographicSize = positiveNumber(value.orthographicSize)
  if (orthographicSize === null || value.fieldOfView !== undefined) return failure(path, 'camera-orthographic', 'Orthographic camera size is invalid.')
  return success({ ...base, type: 'camera', projection: 'orthographic', primary: value.primary, near, far, orthographicSize })
}

function parseLight(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (value.lightKind !== 'ambient' && value.lightKind !== 'directional' && value.lightKind !== 'point' && value.lightKind !== 'spot') return failure(path, 'light-kind', 'Light kind is invalid.')
  const color = parseColor(value.color)
  const intensity = nonNegativeNumber(value.intensity)
  if (!color || intensity === null) return failure(path, 'light', 'Light properties are invalid.')
  if (value.lightKind === 'ambient') {
    if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'lightKind', 'color', 'intensity'])) return failure(path, 'unknown-property', 'Ambient light contains an unsupported property.')
    return success({ ...base, type: 'light', lightKind: 'ambient', color, intensity })
  }
  if (typeof value.castShadow !== 'boolean') return failure(path, 'light-shadow', 'Non-ambient lights require a cast-shadow flag.')
  if (value.lightKind === 'directional') {
    if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'lightKind', 'color', 'intensity', 'castShadow'])) return failure(path, 'unknown-property', 'Directional light contains an unsupported property.')
    return success({ ...base, type: 'light', lightKind: 'directional', color, intensity, castShadow: value.castShadow })
  }
  const range = positiveNumber(value.range)
  if (range === null) return failure(path, 'light-range', 'Point and spot lights require a positive range.')
  if (value.lightKind === 'point') {
    if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'lightKind', 'color', 'intensity', 'range', 'castShadow'])) return failure(path, 'unknown-property', 'Point light contains an unsupported property.')
    return success({ ...base, type: 'light', lightKind: 'point', color, intensity, range, castShadow: value.castShadow })
  }
  const angle = positiveNumber(value.angle)
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'lightKind', 'color', 'intensity', 'range', 'angle', 'castShadow']) || angle === null || angle >= Math.PI) return failure(path, 'light-angle', 'Spot light angle is invalid.')
  return success({ ...base, type: 'light', lightKind: 'spot', color, intensity, range, angle, castShadow: value.castShadow })
}

function parseEnvironment(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'backgroundColor', 'ambientIntensity', 'resourceId'])) return failure(path, 'unknown-property', 'Environment contains an unsupported property.')
  const backgroundColor = parseColor(value.backgroundColor)
  const ambientIntensity = nonNegativeNumber(value.ambientIntensity)
  const resourceId = value.resourceId === undefined ? undefined : canonicalId(value.resourceId)
  if (!backgroundColor || ambientIntensity === null || (value.resourceId !== undefined && !resourceId)) return failure(path, 'environment', 'Environment properties are invalid.')
  return success({ ...base, type: 'environment', backgroundColor, ambientIntensity, ...(resourceId ? { resourceId } : {}) })
}

function parseCollider(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  const commonKeys = ['id', 'type', 'enabled', 'purpose', 'shape', 'sensor', 'friction', 'restitution', 'collisionLayer', 'collisionMask']
  if (value.purpose !== 'simulation' && value.purpose !== 'editor-navigation') return failure(path, 'collider-purpose', 'Collider purpose is invalid.')
  if (typeof value.sensor !== 'boolean') return failure(path, 'collider-sensor', 'Collider sensor flag is invalid.')
  const friction = nonNegativeNumber(value.friction)
  const restitution = rangedNumber(value.restitution, 0, 1)
  const parsedCollisionLayer = value.collisionLayer === undefined ? undefined : unsigned16(value.collisionLayer)
  const parsedCollisionMask = value.collisionMask === undefined ? undefined : unsigned16(value.collisionMask)
  if (friction === null || restitution === null || parsedCollisionLayer === null || parsedCollisionMask === null) return failure(path, 'collider-material', 'Collider material or layers are invalid.')
  const collisionLayer: number | undefined = parsedCollisionLayer
  const collisionMask: number | undefined = parsedCollisionMask
  const purpose: 'simulation' | 'editor-navigation' = value.purpose
  const common = { ...base, type: 'collider' as const, purpose, sensor: value.sensor, friction, restitution, ...(collisionLayer === undefined ? {} : { collisionLayer }), ...(collisionMask === undefined ? {} : { collisionMask }) }
  if (value.shape === 'box') {
    if (!hasOnlyKeys(value, [...commonKeys, 'halfExtents'])) return failure(path, 'unknown-property', 'Box collider contains an unsupported property.')
    const halfExtents = positiveVector3(value.halfExtents)
    return halfExtents ? success({ ...common, shape: 'box', halfExtents }) : failure(path, 'collider-box', 'Box half extents are invalid.')
  }
  if (value.shape === 'sphere') {
    if (!hasOnlyKeys(value, [...commonKeys, 'radius'])) return failure(path, 'unknown-property', 'Sphere collider contains an unsupported property.')
    const radius = positiveNumber(value.radius)
    return radius === null ? failure(path, 'collider-sphere', 'Sphere radius is invalid.') : success({ ...common, shape: 'sphere', radius })
  }
  if (value.shape === 'capsule') {
    if (!hasOnlyKeys(value, [...commonKeys, 'radius', 'halfHeight'])) return failure(path, 'unknown-property', 'Capsule collider contains an unsupported property.')
    const radius = positiveNumber(value.radius)
    const halfHeight = positiveNumber(value.halfHeight)
    return radius === null || halfHeight === null ? failure(path, 'collider-capsule', 'Capsule dimensions are invalid.') : success({ ...common, shape: 'capsule', radius, halfHeight })
  }
  if (value.shape === 'convex' || value.shape === 'mesh') {
    if (!hasOnlyKeys(value, [...commonKeys, 'resourceId'])) return failure(path, 'unknown-property', 'Mesh collider contains an unsupported property.')
    const resourceId = canonicalId(value.resourceId)
    if (!resourceId || (value.shape === 'mesh' && value.purpose !== 'simulation')) return failure(path, 'collider-resource', 'Mesh collider resource is invalid.')
    return success({ ...common, shape: value.shape, resourceId })
  }
  if (value.shape === 'rect-surface') {
    if (!hasOnlyKeys(value, [...commonKeys, 'halfExtents', 'sidedness', 'legacyPreset']) || value.purpose !== 'editor-navigation') return failure(path, 'collider-legacy-purpose', 'Legacy surfaces are editor navigation only.')
    const halfExtents = positiveVector2(value.halfExtents)
    const legacyPreset = parseLegacySurfacePreset(value.legacyPreset, 'rect-surface')
    if (!halfExtents || (value.sidedness !== 'front' && value.sidedness !== 'double') || (value.legacyPreset !== undefined && !legacyPreset)) return failure(path, 'collider-rect', 'Rectangle surface is invalid.')
    return success({ ...common, shape: 'rect-surface', halfExtents, sidedness: value.sidedness, ...(legacyPreset ? { legacyPreset } : {}) })
  }
  if (value.shape === 'tri-surface') {
    if (!hasOnlyKeys(value, [...commonKeys, 'vertices', 'sidedness', 'legacyPreset']) || value.purpose !== 'editor-navigation') return failure(path, 'collider-legacy-purpose', 'Legacy surfaces are editor navigation only.')
    const vertices = triangleVertices(value.vertices)
    const legacyPreset = parseLegacySurfacePreset(value.legacyPreset, 'tri-surface')
    if (!vertices || (value.sidedness !== 'front' && value.sidedness !== 'double') || (value.legacyPreset !== undefined && !legacyPreset)) return failure(path, 'collider-triangle', 'Triangle surface is invalid.')
    return success({ ...common, shape: 'tri-surface', vertices, sidedness: value.sidedness, ...(legacyPreset ? { legacyPreset } : {}) })
  }
  return failure(path, 'collider-shape', 'Collider shape is invalid.')
}

function parseRigidBody(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'bodyType', 'gravityScale', 'linearDamping', 'angularDamping', 'canSleep'])) return failure(path, 'unknown-property', 'Rigid body contains an unsupported property.')
  if (value.bodyType !== 'fixed' && value.bodyType !== 'dynamic' && value.bodyType !== 'kinematic-position' && value.bodyType !== 'kinematic-velocity') return failure(path, 'rigid-body-type', 'Rigid body type is invalid.')
  const gravityScale = finiteNumber(value.gravityScale)
  const linearDamping = nonNegativeNumber(value.linearDamping)
  const angularDamping = nonNegativeNumber(value.angularDamping)
  if (gravityScale === null || linearDamping === null || angularDamping === null || typeof value.canSleep !== 'boolean') return failure(path, 'rigid-body', 'Rigid body properties are invalid.')
  return success({ ...base, type: 'rigid-body', bodyType: value.bodyType, gravityScale, linearDamping, angularDamping, canSleep: value.canSleep })
}

function parseCharacterController(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'colliderComponentId', 'moveActionId', 'jumpActionId', 'speed', 'jumpSpeed', 'maxSlopeDegrees'])) return failure(path, 'unknown-property', 'Character controller contains an unsupported property.')
  const colliderComponentId = canonicalId(value.colliderComponentId)
  const moveActionId = canonicalId(value.moveActionId)
  const jumpActionId = value.jumpActionId === undefined ? undefined : canonicalId(value.jumpActionId)
  const speed = nonNegativeNumber(value.speed)
  const jumpSpeed = nonNegativeNumber(value.jumpSpeed)
  const maxSlopeDegrees = rangedNumber(value.maxSlopeDegrees, 0, 90)
  if (!colliderComponentId || !moveActionId || (value.jumpActionId !== undefined && !jumpActionId) || speed === null || jumpSpeed === null || maxSlopeDegrees === null) return failure(path, 'character-controller', 'Character controller properties are invalid.')
  return success({ ...base, type: 'character-controller', colliderComponentId, moveActionId, ...(jumpActionId ? { jumpActionId } : {}), speed, jumpSpeed, maxSlopeDegrees })
}

function parseAnimationPlayer(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'resourceId', 'autoplay', 'loop', 'speed'])) return failure(path, 'unknown-property', 'Animation player contains an unsupported property.')
  const resourceId = canonicalId(value.resourceId)
  const speed = finiteNumber(value.speed)
  if (!resourceId || typeof value.autoplay !== 'boolean' || typeof value.loop !== 'boolean' || speed === null || speed === 0) return failure(path, 'animation-player', 'Animation player properties are invalid.')
  return success({ ...base, type: 'animation-player', resourceId, autoplay: value.autoplay, loop: value.loop, speed })
}

function parseAudioSource(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'resourceId', 'autoplay', 'loop', 'volume', 'spatial', 'maxDistance'])) return failure(path, 'unknown-property', 'Audio source contains an unsupported property.')
  const resourceId = canonicalId(value.resourceId)
  const volume = rangedNumber(value.volume, 0, 1)
  const maxDistance = positiveNumber(value.maxDistance)
  if (!resourceId || typeof value.autoplay !== 'boolean' || typeof value.loop !== 'boolean' || volume === null || typeof value.spatial !== 'boolean' || maxDistance === null) return failure(path, 'audio-source', 'Audio source properties are invalid.')
  return success({ ...base, type: 'audio-source', resourceId, autoplay: value.autoplay, loop: value.loop, volume, spatial: value.spatial, maxDistance })
}

function parseAudioListener(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'primary']) || typeof value.primary !== 'boolean') return failure(path, 'audio-listener', 'Audio listener properties are invalid.')
  return success({ ...base, type: 'audio-listener', primary: value.primary })
}

function parseTrigger(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'colliderComponentId', 'once', 'targetTags'])) return failure(path, 'unknown-property', 'Trigger contains an unsupported property.')
  const colliderComponentId = canonicalId(value.colliderComponentId)
  const targetTags = stringArray(value.targetTags)
  if (!colliderComponentId || typeof value.once !== 'boolean' || !targetTags) return failure(path, 'trigger', 'Trigger properties are invalid.')
  return success({ ...base, type: 'trigger', colliderComponentId, once: value.once, targetTags })
}

function parseBehavior(value: Record<string, unknown>, base: ParsedBase, path: string): ParseWorldComponentResult {
  if (!hasOnlyKeys(value, ['id', 'type', 'enabled', 'bindings']) || !Array.isArray(value.bindings)) return failure(path, 'behavior', 'Behavior bindings are invalid.')
  if (value.bindings.length > WORLD_MAX_COLLECTION_ITEMS) return failure(`${path}.bindings`, 'collection-limit', `Behavior cannot contain more than ${WORLD_MAX_COLLECTION_ITEMS} bindings.`)
  const bindings: WorldBehaviorBinding[] = []
  const ids = new Set<string>()
  for (const [index, candidate] of value.bindings.entries()) {
    const binding = parseBehaviorBinding(candidate)
    if (!binding || ids.has(binding.id)) return failure(`${path}.bindings[${index}]`, 'behavior-binding', 'Behavior binding is invalid or duplicated.')
    ids.add(binding.id)
    bindings.push(binding)
  }
  return success({ ...base, type: 'behavior', bindings })
}

function parseBehaviorBinding(value: unknown): WorldBehaviorBinding | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'event', 'actions']) || !Array.isArray(value.actions)) return null
  const id = canonicalId(value.id)
  const event = parseBehaviorEvent(value.event)
  if (!id || !event) return null
  if (value.actions.length > WORLD_MAX_COLLECTION_ITEMS) return null
  const actions: WorldBehaviorAction[] = []
  for (const candidate of value.actions) {
    const action = parseBehaviorAction(candidate)
    if (!action) return null
    actions.push(action)
  }
  return { id, event, actions }
}

function parseBehaviorEvent(value: unknown): WorldBehaviorEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'start' && hasOnlyKeys(value, ['type'])) return { type: 'start' }
  if (value.type === 'input' && hasOnlyKeys(value, ['type', 'actionId', 'phase'])) {
    const actionId = canonicalId(value.actionId)
    if (actionId && (value.phase === 'pressed' || value.phase === 'released' || value.phase === 'held')) return { type: 'input', actionId, phase: value.phase }
  }
  if ((value.type === 'trigger-enter' || value.type === 'trigger-exit') && hasOnlyKeys(value, ['type', 'triggerComponentId'])) {
    const triggerComponentId = canonicalId(value.triggerComponentId)
    if (triggerComponentId) return { type: value.type, triggerComponentId }
  }
  if (value.type === 'timer' && hasOnlyKeys(value, ['type', 'delaySeconds', 'repeat'])) {
    const delaySeconds = positiveNumber(value.delaySeconds)
    if (delaySeconds !== null && typeof value.repeat === 'boolean') return { type: 'timer', delaySeconds, repeat: value.repeat }
  }
  if (value.type === 'sequence-event' && hasOnlyKeys(value, ['type', 'sequenceId', 'eventId'])) {
    const sequenceId = canonicalId(value.sequenceId)
    const eventId = canonicalId(value.eventId)
    if (sequenceId && eventId) return { type: 'sequence-event', sequenceId, eventId }
  }
  return null
}

function parseBehaviorAction(value: unknown): WorldBehaviorAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'set-visibility' && hasOnlyKeys(value, ['type', 'entityId', 'visible'])) {
    const entityId = canonicalId(value.entityId)
    if (entityId && typeof value.visible === 'boolean') return { type: 'set-visibility', entityId, visible: value.visible }
  }
  if (value.type === 'set-component-property' && hasOnlyKeys(value, ['type', 'entityId', 'componentId', 'componentType', 'property', 'value'])) {
    const entityId = canonicalId(value.entityId)
    const componentId = canonicalId(value.componentId)
    const property = propertyName(value.property)
    if (entityId && componentId && property && isWorldComponentType(value.componentType)
      && isWorldComponentPropertyWritable(value.componentType, property, value.value)) {
      return { type: 'set-component-property', entityId, componentId, componentType: value.componentType, property, value: cloneWritableValue(value.value) }
    }
  }
  if ((value.type === 'play-animation' || value.type === 'play-audio' || value.type === 'stop-audio') && hasOnlyKeys(value, ['type', 'entityId', 'componentId'])) {
    const entityId = canonicalId(value.entityId)
    const componentId = canonicalId(value.componentId)
    if (entityId && componentId) return { type: value.type, entityId, componentId }
  }
  if (value.type === 'apply-impulse' && hasOnlyKeys(value, ['type', 'entityId', 'impulse'])) {
    const entityId = canonicalId(value.entityId)
    const impulse = vector3(value.impulse)
    if (entityId && impulse) return { type: 'apply-impulse', entityId, impulse }
  }
  if (value.type === 'change-scene' && hasOnlyKeys(value, ['type', 'sceneId'])) {
    const sceneId = canonicalId(value.sceneId)
    if (sceneId) return { type: 'change-scene', sceneId }
  }
  return null
}

function collectBehaviorReferences(component: WorldBehaviorComponent, add: (reference: WorldComponentReference) => void): void {
  for (const [bindingIndex, binding] of component.bindings.entries()) {
    const prefix = `bindings[${bindingIndex}]`
    if (binding.event.type === 'input') add({ kind: 'input-action', id: binding.event.actionId, path: `${prefix}.event.actionId` })
    if (binding.event.type === 'trigger-enter' || binding.event.type === 'trigger-exit') add({ kind: 'component', id: binding.event.triggerComponentId, path: `${prefix}.event.triggerComponentId` })
    if (binding.event.type === 'sequence-event') add({ kind: 'sequence', id: binding.event.sequenceId, path: `${prefix}.event.sequenceId` })
    for (const [actionIndex, action] of binding.actions.entries()) {
      const actionPath = `${prefix}.actions[${actionIndex}]`
      if (action.type === 'change-scene') add({ kind: 'scene', id: action.sceneId, path: `${actionPath}.sceneId` })
      if ('entityId' in action) add({ kind: 'entity', id: action.entityId, path: `${actionPath}.entityId` })
      if ('componentId' in action) add({ kind: 'component', id: action.componentId, path: `${actionPath}.componentId` })
    }
  }
}

function parseMaterial(value: unknown): WorldRenderableComponent['material'] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['baseColor', 'metallic', 'roughness', 'opacity'])) return null
  const baseColor = parseColor(value.baseColor)
  const metallic = rangedNumber(value.metallic, 0, 1)
  const roughness = rangedNumber(value.roughness, 0, 1)
  const opacity = rangedNumber(value.opacity, 0, 1)
  return baseColor && metallic !== null && roughness !== null && opacity !== null ? { baseColor, metallic, roughness, opacity } : null
}

function failure(path: string, code: string, message: string): ParseWorldComponentResult {
  return { success: false, issues: [{ code, path, message }] }
}

function success(value: WorldComponent): ParseWorldComponentResult {
  return { success: true, value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isSafeWorldWireRecord(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value)
  if (ownKeys.length > WORLD_MAX_RECORD_KEYS || ownKeys.some((key) => key.length > 256)) return false
  const allowed = new Set(keys)
  return ownKeys.every((key) => allowed.has(key))
}

function canonicalId(value: unknown): string | null {
  return isWorldCanonicalId(value) ? value : null
}

function propertyName(value: unknown): string | null {
  return isWorldCanonicalPropertyName(value) ? value : null
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > WORLD_MAX_COLLECTION_ITEMS) return null
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const parsed = canonicalId(item)
    if (!parsed || seen.has(parsed)) return null
    seen.add(parsed)
    result.push(parsed)
  }
  return result
}

function parseLegacySurfacePreset(value: unknown, shape: 'rect-surface'): Exclude<WorldLegacyCollisionSurfacePreset, 'triangle'> | undefined
function parseLegacySurfacePreset(value: unknown, shape: 'tri-surface'): Extract<WorldLegacyCollisionSurfacePreset, 'triangle'> | undefined
function parseLegacySurfacePreset(value: unknown, shape: 'rect-surface' | 'tri-surface'): WorldLegacyCollisionSurfacePreset | undefined {
  if (value === undefined) return undefined
  if (shape === 'tri-surface') return value === 'triangle' ? value : undefined
  return value === 'rectangle' || value === 'square' || value === 'wall' || value === 'floor' || value === 'ramp' ? value : undefined
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function rangedNumber(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null
}

function inOpenRange(value: unknown, minimum: number, maximum: number): boolean {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed > minimum && parsed < maximum
}

function unsigned16(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff ? value : null
}

function vector2(value: unknown): WorldVector2 | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const first = finiteNumber(value[0])
  const second = finiteNumber(value[1])
  return first === null || second === null ? null : [first, second]
}

function positiveVector2(value: unknown): WorldVector2 | null {
  const parsed = vector2(value)
  return parsed && parsed.every((item) => item > 0) ? parsed : null
}

function vector3(value: unknown): WorldVector3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const first = finiteNumber(value[0])
  const second = finiteNumber(value[1])
  const third = finiteNumber(value[2])
  return first === null || second === null || third === null ? null : [first, second, third]
}

function positiveVector3(value: unknown): WorldVector3 | null {
  const parsed = vector3(value)
  return parsed && parsed.every((item) => item > 0) ? parsed : null
}

function triangleVertices(value: unknown): [WorldVector2, WorldVector2, WorldVector2] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const first = vector2(value[0])
  const second = vector2(value[1])
  const third = vector2(value[2])
  if (!first || !second || !third) return null
  const area = (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])
  return Math.abs(area) > Number.EPSILON ? [first, second, third] : null
}

function parseColor(value: unknown): WorldColor | null {
  return isWorldColor(value) ? value : null
}

function isWorldColor(value: unknown): value is WorldColor {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)
}

function isWorldComponentType(value: unknown): value is WorldComponentType {
  return typeof value === 'string' && WORLD_COMPONENT_TYPES.some((type) => type === value)
}

function cloneWritableValue(value: unknown): WorldWritableValue {
  const tuple = vector3(value)
  if (tuple) return tuple
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  throw new Error('Writable value was not validated.')
}

function compareReference(left: WorldComponentReference, right: WorldComponentReference): number {
  return left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
}
