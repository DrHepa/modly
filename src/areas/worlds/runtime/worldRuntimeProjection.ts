import { Euler, Quaternion } from 'three'

import type { WorldColliderComponent, WorldRigidBodyComponent } from '../core/worldComponentRegistry.ts'
import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import { isWorldGltfAnimationResourceBoundToModel, type WorldProjectSnapshotV1, type WorldTransform } from '../core/worldModel.ts'
import type {
  WorldPhysicsBodyDto,
  WorldPhysicsColliderDto,
  WorldPhysicsColliderShapeDto,
  WorldPhysicsQuaternion,
  WorldPhysicsSceneDto,
} from './worldPhysicsProtocol.ts'
import {
  resolveWorldRuntimeEffectiveEnabled,
  resolveWorldRuntimeEntityPoses,
  resolveWorldRuntimeTransforms,
} from './worldRuntimeEntityGraph.ts'

export interface WorldRuntimeProjectionIssue {
  code: string
  path: string
  message: string
}

export interface WorldRuntimeSceneProjection {
  sceneId: string
  primaryCameraEntityId: string
  primaryListenerEntityId: string | null
  worldPoses: readonly {
    entityId: string
    position: WorldTransform['position']
    rotation: WorldPhysicsQuaternion
  }[]
  physics: WorldPhysicsSceneDto
}

export type ProjectWorldRuntimeSceneResult =
  | { success: true; value: WorldRuntimeSceneProjection }
  | { success: false; issues: WorldRuntimeProjectionIssue[] }

export type WorldRuntimeColliderShapePlan =
  | WorldPhysicsColliderShapeDto
  | { kind: 'convexHullSource'; resourceId: string; resourceWorkspacePath: string; resourceFormat: 'glb' | 'gltf' | 'ply-mesh'; entityScale: WorldTransform['scale'] }
  | { kind: 'trimeshSource'; resourceId: string; resourceWorkspacePath: string; resourceFormat: 'glb' | 'gltf' | 'ply-mesh'; entityScale: WorldTransform['scale'] }

export type WorldRuntimeColliderPlan = Omit<WorldPhysicsColliderDto, 'shape'> & { shape: WorldRuntimeColliderShapePlan }
export type WorldRuntimeBodyPlan = Omit<WorldPhysicsBodyDto, 'colliders'> & { colliders: WorldRuntimeColliderPlan[] }
export interface WorldRuntimeScenePlan extends Omit<WorldRuntimeSceneProjection, 'physics'> {
  physics: Omit<WorldPhysicsSceneDto, 'bodies'> & { bodies: WorldRuntimeBodyPlan[] }
}

export type PlanWorldRuntimeSceneResult =
  | { success: true; value: WorldRuntimeScenePlan }
  | { success: false; issues: WorldRuntimeProjectionIssue[] }

const DEFAULT_COLLISION_LAYER = 1
const DEFAULT_COLLISION_MASK = 0xffff

export function projectWorldRuntimeScene(snapshotValue: WorldProjectSnapshotV1, sceneId: string): ProjectWorldRuntimeSceneResult {
  const planned = planWorldRuntimeScene(snapshotValue, sceneId)
  if (!planned.success) return planned
  const issues: WorldRuntimeProjectionIssue[] = []
  const bodies: WorldPhysicsBodyDto[] = planned.value.physics.bodies.map((body, bodyIndex) => ({
    ...body,
    colliders: body.colliders.flatMap((collider, colliderIndex): WorldPhysicsColliderDto[] => {
      if (collider.shape.kind === 'convexHullSource' || collider.shape.kind === 'trimeshSource') {
        issues.push({
          code: 'unsupported-physics-shape',
          path: `physics.bodies[${bodyIndex}].colliders[${colliderIndex}].shape`,
          message: `Play physics requires prepared numeric geometry for ${collider.shape.kind === 'convexHullSource' ? 'convex' : 'mesh'} colliders.`,
        })
        return []
      }
      return [{ ...collider, shape: collider.shape }]
    }),
  }))
  if (issues.length > 0) return { success: false, issues }
  return { success: true, value: { ...planned.value, physics: { ...planned.value.physics, bodies } } }
}

export function planWorldRuntimeScene(snapshotValue: WorldProjectSnapshotV1, sceneId: string): PlanWorldRuntimeSceneResult {
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) return { success: false, issues: validated.issues.map((issue) => ({ ...issue })) }
  const snapshot = validated.value
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) return failure('scene-missing', 'sceneId', `Scene ${sceneId} does not exist.`)

  const issues: WorldRuntimeProjectionIssue[] = []
  const resolved = resolveWorldRuntimeTransforms(scene.entities)
  const effectiveEnabledById = resolveWorldRuntimeEffectiveEnabled(scene.entities)
  const effectiveEnabled = (entityId: string): boolean => effectiveEnabledById.get(entityId) === true

  const primaryCameras = scene.entities.filter((entity) => effectiveEnabled(entity.id)
    && entity.components.some((component) => component.type === 'camera' && component.enabled && component.primary))
  if (primaryCameras.length !== 1) {
    issues.push({ code: 'runtime-primary-camera', path: `scenes.${sceneId}.entities`, message: 'Play requires exactly one enabled primary camera.' })
  }
  const primaryListeners = scene.entities.filter((entity) => effectiveEnabled(entity.id)
    && entity.components.some((component) => component.type === 'audio-listener' && component.enabled && component.primary))
  const hasAudio = scene.entities.some((entity) => effectiveEnabled(entity.id)
    && entity.components.some((component) => component.type === 'audio-source' && component.enabled))
  if (hasAudio && primaryListeners.length !== 1) {
    issues.push({ code: 'runtime-primary-listener', path: `scenes.${sceneId}.entities`, message: 'Scenes with audio require exactly one enabled primary audio listener.' })
  }
  const resources = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
  for (const [entityIndex, entity] of scene.entities.entries()) {
    if (!effectiveEnabled(entity.id)) continue
    const renderable = entity.components.find((component) => component.type === 'renderable' && component.enabled)
    for (const [componentIndex, component] of entity.components.entries()) {
      if (component.type !== 'animation-player' || !component.enabled) continue
      const resource = resources.get(component.resourceId)
      const model = renderable?.type === 'renderable' ? resources.get(renderable.resourceId) : undefined
      if (!resource || resource.type !== 'animation' || resource.format !== 'gltf-clip'
        || !model || model.type !== 'model' || !isWorldGltfAnimationResourceBoundToModel(resource, model)) {
        issues.push({
          code: 'unsupported-runtime-animation',
          path: `scenes[${entityIndex}].entities.${entity.id}.components[${componentIndex}]`,
          message: 'Play animation currently requires a glTF clip bound to the rendered model (GLB or glTF).',
        })
      }
    }
  }

  const bodies: WorldRuntimeBodyPlan[] = []
  for (const [entityIndex, entity] of scene.entities.entries()) {
    if (!effectiveEnabled(entity.id)) continue
    const transform = resolved.get(entity.id)
    if (!transform) continue
    const simulationColliders = entity.components.filter((component): component is WorldColliderComponent => (
      component.type === 'collider' && component.enabled && component.purpose === 'simulation'
    ))
    const rigidBody = entity.components.find((component): component is WorldRigidBodyComponent => component.type === 'rigid-body' && component.enabled)
    const controller = entity.components.find((component) => component.type === 'character-controller' && component.enabled)
    if (simulationColliders.length === 0 && !rigidBody && !controller) continue

    const triggerIdsByCollider = new Map<string, string[]>()
    for (const component of entity.components) {
      if (component.type !== 'trigger' || !component.enabled) continue
      const ids = triggerIdsByCollider.get(component.colliderComponentId) ?? []
      ids.push(component.id)
      triggerIdsByCollider.set(component.colliderComponentId, ids)
    }
    const colliders: WorldRuntimeColliderPlan[] = []
    for (const [componentIndex, collider] of simulationColliders.entries()) {
      const shape = projectColliderShapePlan(collider, transform.scale, rigidBody?.bodyType ?? 'fixed', resources)
      if (!shape) {
        issues.push({
          code: collider.shape === 'mesh' ? 'unsupported-physics-static-mesh-body' : 'unsupported-physics-geometry-source',
          path: `scenes[${entityIndex}].entities.${entity.id}.components[${componentIndex}].shape`,
          message: collider.shape === 'mesh' ? 'Static Mesh colliders require a fixed rigid body.' : `Play physics cannot resolve ${collider.shape} collider resource.`,
        })
        continue
      }
      colliders.push({
        componentId: collider.id,
        shape,
        sensor: collider.sensor,
        friction: collider.friction,
        restitution: collider.restitution,
        collisionLayer: collider.collisionLayer ?? DEFAULT_COLLISION_LAYER,
        collisionMask: collider.collisionMask ?? DEFAULT_COLLISION_MASK,
        triggerComponentIds: [...(triggerIdsByCollider.get(collider.id) ?? [])],
      })
    }

    bodies.push({
      entityId: entity.id,
      bodyType: rigidBody?.bodyType ?? 'fixed',
      position: [...transform.position],
      rotation: quaternionFromEuler(transform.rotation),
      gravityScale: rigidBody?.gravityScale ?? 0,
      linearDamping: rigidBody?.linearDamping ?? 0,
      angularDamping: rigidBody?.angularDamping ?? 0,
      canSleep: rigidBody?.canSleep ?? true,
      tags: [...entity.tags],
      colliders,
      ...(controller?.type === 'character-controller' ? {
        controller: {
          componentId: controller.id,
          colliderComponentId: controller.colliderComponentId,
          moveActionId: controller.moveActionId,
          ...(controller.jumpActionId ? { jumpActionId: controller.jumpActionId } : {}),
          speed: controller.speed,
          jumpSpeed: controller.jumpSpeed,
          maxSlopeRadians: controller.maxSlopeDegrees * Math.PI / 180,
        },
      } : {}),
    })
  }

  if (issues.length > 0 || primaryCameras.length !== 1) return { success: false, issues }
  return {
    success: true,
    value: {
      sceneId,
      primaryCameraEntityId: primaryCameras[0].id,
      primaryListenerEntityId: primaryListeners[0]?.id ?? null,
      worldPoses: resolveWorldRuntimeEntityPoses(scene.entities),
      physics: { sceneId, gravity: [0, -9.81, 0], bodies },
    },
  }
}

export function projectColliderShapePlan(
  collider: WorldColliderComponent,
  scale: WorldTransform['scale'],
  bodyType: WorldRigidBodyComponent['bodyType'],
  resources: ReadonlyMap<string, WorldProjectSnapshotV1['project']['resources'][number]>,
): WorldRuntimeColliderShapePlan | null {
  const absolute = scale.map((value) => Math.abs(value)) as WorldTransform['scale']
  if (collider.shape === 'box') {
    return { kind: 'box', halfExtents: collider.halfExtents.map((value, index) => value * absolute[index]) as WorldTransform['scale'] }
  }
  if (collider.shape === 'sphere') return { kind: 'sphere', radius: collider.radius * Math.max(...absolute) }
  if (collider.shape === 'capsule') {
    return {
      kind: 'capsule',
      radius: collider.radius * Math.max(absolute[0], absolute[2]),
      halfHeight: collider.halfHeight * absolute[1],
    }
  }
  if (collider.shape === 'convex' || collider.shape === 'mesh') {
    if (collider.shape === 'mesh' && bodyType !== 'fixed') return null
    const resource = resources.get(collider.resourceId)
    if (!resource || resource.type !== 'model' || (resource.format !== 'glb' && resource.format !== 'gltf' && resource.format !== 'ply-mesh')) return null
    return {
      kind: collider.shape === 'convex' ? 'convexHullSource' : 'trimeshSource',
      resourceId: resource.id,
      resourceWorkspacePath: resource.workspacePath,
      resourceFormat: resource.format,
      entityScale: [...scale] as WorldTransform['scale'],
    }
  }
  return null
}

function quaternionFromEuler(rotation: WorldTransform['rotation']): WorldPhysicsQuaternion {
  const quaternion = new Quaternion().setFromEuler(new Euler(...rotation, 'XYZ'))
  return [clean(quaternion.x), clean(quaternion.y), clean(quaternion.z), clean(quaternion.w)]
}

function clean(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < 1e-12 ? 0 : value
}

function failure(code: string, path: string, message: string): ProjectWorldRuntimeSceneResult {
  return { success: false, issues: [{ code, path, message }] }
}
