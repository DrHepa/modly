import { Euler, Matrix4, Quaternion, Vector3 } from 'three'

import type { WorldEntity, WorldTransform } from '../core/worldModel.ts'
import type { WorldPhysicsQuaternion } from './worldPhysicsProtocol.ts'

export interface WorldRuntimeEntityPose {
  entityId: string
  position: WorldTransform['position']
  rotation: WorldPhysicsQuaternion
}

export function resolveWorldRuntimeEffectiveEnabled(entities: readonly WorldEntity[]): ReadonlyMap<string, boolean> {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const resolved = new Map<string, boolean>()
  const visiting = new Set<string>()
  const resolve = (entityId: string): boolean => {
    const cached = resolved.get(entityId)
    if (cached !== undefined) return cached
    const entity = byId.get(entityId)
    if (!entity || visiting.has(entityId)) return false
    visiting.add(entityId)
    const parentEnabled = entity.parentId === null ? true : byId.has(entity.parentId) && resolve(entity.parentId)
    const enabled = entity.enabled && parentEnabled
    visiting.delete(entityId)
    resolved.set(entityId, enabled)
    return enabled
  }
  for (const entity of entities) resolve(entity.id)
  return resolved
}

export function resolveWorldRuntimeTransforms(
  entities: readonly WorldEntity[],
  authoritativeWorldPoses: readonly WorldRuntimeEntityPose[] = [],
): ReadonlyMap<string, WorldTransform> {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const poseById = new Map(authoritativeWorldPoses.map((pose) => [pose.entityId, pose]))
  const authoredMatrices = resolveMatrices(entities, byId, new Map())
  const runtimeMatrices = resolveMatrices(entities, byId, poseById, authoredMatrices)
  return new Map([...runtimeMatrices].map(([entityId, matrix]) => [entityId, decomposeTransform(matrix)]))
}

export function resolveWorldRuntimeEntityPoses(
  entities: readonly WorldEntity[],
  authoritativeWorldPoses: readonly WorldRuntimeEntityPose[] = [],
): WorldRuntimeEntityPose[] {
  const effectiveEnabled = resolveWorldRuntimeEffectiveEnabled(entities)
  const transforms = resolveWorldRuntimeTransforms(entities, authoritativeWorldPoses)
  return entities.flatMap((entity): WorldRuntimeEntityPose[] => {
    if (!effectiveEnabled.get(entity.id)) return []
    const transform = transforms.get(entity.id)
    if (!transform) return []
    const quaternion = new Quaternion().setFromEuler(new Euler(...transform.rotation, 'XYZ'))
    return [{
      entityId: entity.id,
      position: [...transform.position],
      rotation: [clean(quaternion.x), clean(quaternion.y), clean(quaternion.z), clean(quaternion.w)],
    }]
  })
}

function resolveMatrices(
  entities: readonly WorldEntity[],
  byId: ReadonlyMap<string, WorldEntity>,
  poseById: ReadonlyMap<string, WorldRuntimeEntityPose>,
  authoredMatrices?: ReadonlyMap<string, Matrix4>,
): Map<string, Matrix4> {
  const resolved = new Map<string, Matrix4>()
  const visiting = new Set<string>()
  const resolve = (entityId: string): Matrix4 | null => {
    const cached = resolved.get(entityId)
    if (cached) return cached
    const entity = byId.get(entityId)
    if (!entity || visiting.has(entityId)) return null
    visiting.add(entityId)
    const pose = poseById.get(entityId)
    let matrix: Matrix4 | null
    if (pose) {
      const authored = authoredMatrices?.get(entityId)
      const authoredScale = authored ? decomposeTransform(authored).scale : entity.transform.scale
      matrix = composePose(pose, authoredScale)
    } else {
      const local = composeTransform(entity.transform)
      if (entity.parentId === null) matrix = local
      else {
        const parent = resolve(entity.parentId)
        matrix = parent ? parent.clone().multiply(local) : null
      }
    }
    visiting.delete(entityId)
    if (matrix) resolved.set(entityId, matrix)
    return matrix
  }
  for (const entity of entities) resolve(entity.id)
  return resolved
}

function composeTransform(transform: WorldTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, 'XYZ')),
    new Vector3(...transform.scale),
  )
}

function composePose(pose: WorldRuntimeEntityPose, scale: WorldTransform['scale']): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...pose.position),
    new Quaternion(...pose.rotation).normalize(),
    new Vector3(...scale),
  )
}

function decomposeTransform(matrix: Matrix4): WorldTransform {
  const position = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3()
  matrix.decompose(position, rotation, scale)
  const euler = new Euler().setFromQuaternion(rotation.normalize(), 'XYZ')
  return {
    position: [clean(position.x), clean(position.y), clean(position.z)],
    rotation: [clean(euler.x), clean(euler.y), clean(euler.z)],
    scale: [clean(scale.x), clean(scale.y), clean(scale.z)],
  }
}

function clean(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < 1e-12 ? 0 : value
}
