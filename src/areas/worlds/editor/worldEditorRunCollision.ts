import { Euler, Quaternion, Vector3 } from 'three'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import { resolveWorldRuntimeEffectiveEnabled, resolveWorldRuntimeTransforms } from '../runtime/worldRuntimeEntityGraph.ts'
import { projectColliderShapePlan, type WorldRuntimeBodyPlan, type WorldRuntimeProjectionIssue } from '../runtime/worldRuntimeProjection.ts'
import { WORLD_NAVIGATION_COLLISION_LAYER, WORLD_NAVIGATION_COLLISION_MASK, type WorldPhysicsNavigationInit } from '../runtime/worldPhysicsProtocol.ts'

export interface WorldEditorRunCollisionInput {
  snapshot: WorldProjectSnapshotV1
  sceneId: string
  apiUrl: string
  /** Synchronous editor lease + revision check, including pending Play intent. */
  isCurrent(): boolean
}

export function planWorldEditorRunCollision(snapshotValue: WorldProjectSnapshotV1, sceneId: string):
  | { success: true; plan: { physics: { sceneId: string; gravity: [number, number, number]; bodies: WorldRuntimeBodyPlan[] } }; frontSurfaces: WorldPhysicsNavigationInit['frontSurfaces'] }
  | { success: false; issues: WorldRuntimeProjectionIssue[] } {
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) return validated
  const snapshot = validated.value
  const scene = snapshot.scenes.find(scene => scene.sceneId === sceneId)
  if (!scene) return { success: false, issues: [{ code: 'scene-missing', path: 'sceneId', message: 'Run scene is unavailable.' }] }
  const transforms = resolveWorldRuntimeTransforms(scene.entities)
  const enabled = resolveWorldRuntimeEffectiveEnabled(scene.entities)
  const resources = new Map(snapshot.project.resources.map(resource => [resource.id, resource]))
  const bodies: WorldRuntimeBodyPlan[] = []
  const frontSurfaces: WorldPhysicsNavigationInit['frontSurfaces'] = []
  for (const entity of scene.entities) {
    if (!enabled.get(entity.id)) continue
    const transform = transforms.get(entity.id)!
    const renderables = entity.components.filter(component => component.type === 'renderable')
    const hidden = renderables.length > 0 && !renderables.some(component => component.enabled && component.visible)
    const rotation = new Quaternion().setFromEuler(new Euler(...transform.rotation, 'XYZ'))
    const body: WorldRuntimeBodyPlan = {
      entityId: entity.id, bodyType: 'fixed', position: [...transform.position], rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      gravityScale: 0, linearDamping: 0, angularDamping: 0, canSleep: true, tags: [], colliders: [],
    }
    for (const collider of entity.components) {
      if (collider.type !== 'collider' || !collider.enabled || collider.sensor) continue
      // Explicit editor-navigation surfaces retain their existing authoring semantics.
      if (collider.purpose === 'simulation' && hidden) continue
      const collisionLayer = collider.collisionLayer ?? 1
      const collisionMask = collider.collisionMask ?? 0xffff
      // Same two-way Rapier interaction-group policy as the camera query in the Worker.
      if (!(collisionLayer & WORLD_NAVIGATION_COLLISION_MASK) || !(collisionMask & WORLD_NAVIGATION_COLLISION_LAYER)) continue
      const rigidBody = entity.components.find(component => component.type === 'rigid-body' && component.enabled)
      let shape = projectColliderShapePlan(collider, transform.scale, rigidBody?.type === 'rigid-body' ? rigidBody.bodyType : 'fixed', resources)
      if (collider.shape === 'rect-surface' || collider.shape === 'tri-surface') {
        const vertices = collider.shape === 'rect-surface'
          ? [[-collider.halfExtents[0], -collider.halfExtents[1]], [-collider.halfExtents[0], collider.halfExtents[1]], [collider.halfExtents[0], collider.halfExtents[1]], [collider.halfExtents[0], -collider.halfExtents[1]]]
          : collider.vertices
        shape = { kind: 'trimesh', vertices: new Float32Array(vertices.flatMap(([x, z]) => [x * transform.scale[0], 0, z * transform.scale[2]])), indices: new Uint32Array(vertices.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]) }
        if (collider.sidedness === 'front') {
          const normal = new Vector3(0, 1, 0).applyQuaternion(rotation)
          frontSurfaces.push({ componentId: collider.id, point: [...transform.position], normal: [normal.x, normal.y, normal.z] })
        }
      }
      if (!shape) return { success: false, issues: [{ code: 'navigation-collider-unavailable', path: collider.id, message: `Run cannot prepare the authored ${collider.shape} collider.` }] }
      body.colliders.push({ componentId: collider.id, shape, sensor: false, friction: collider.friction, restitution: collider.restitution, collisionLayer, collisionMask, triggerComponentIds: [] })
    }
    if (body.colliders.length) bodies.push(body)
  }
  return { success: true, plan: { physics: { sceneId, gravity: [0, -9.81, 0], bodies } }, frontSurfaces }
}
