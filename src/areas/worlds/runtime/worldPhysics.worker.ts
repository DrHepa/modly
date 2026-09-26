/// <reference lib="webworker" />

import type RAPIER_API from '@dimforge/rapier3d'
import type * as RAPIER_TYPES from '@dimforge/rapier3d'

import { WORLD_FIXED_STEP_SECONDS } from './worldRuntimeClock.ts'
import {
  parseWorldPhysicsMainMessage,
  WORLD_PHYSICS_PROTOCOL_VERSION,
  WORLD_PHYSICS_TRANSFORM_STRIDE,
  type WorldPhysicsBodyDto,
  type WorldPhysicsCharacterInput,
  type WorldPhysicsColliderDto,
  type WorldPhysicsFixedStep,
  type WorldPhysicsStepTiming,
  type WorldPhysicsTriggerEvent,
} from './worldPhysicsProtocol.ts'
import { executeWorldPhysicsFixedSteps } from './worldRapierStep.ts'

interface RuntimeColliderMetadata {
  entityId: string
  tags: string[]
  triggerComponentIds: string[]
}

interface RuntimeCharacter {
  input: NonNullable<WorldPhysicsBodyDto['controller']>
  collider: RAPIER_TYPES.Collider
  controller: RAPIER_TYPES.KinematicCharacterController
  verticalVelocity: number
  grounded: boolean
}

interface RuntimeBody {
  dto: WorldPhysicsBodyDto
  body: RAPIER_TYPES.RigidBody
  character: RuntimeCharacter | null
}

type RapierApi = typeof RAPIER_API

const scope = self as DedicatedWorkerGlobalScope
let RAPIER: RapierApi
let rapierLoadPromise: Promise<RapierApi> | null = null
let initializingGenerationId: number | null = null
let generationId = 0
let world: RAPIER_TYPES.World | null = null
let eventQueue: RAPIER_TYPES.EventQueue | null = null
let bodies: RuntimeBody[] = []
let bodiesByEntity = new Map<string, RuntimeBody>()
let colliderMetadata = new Map<number, RuntimeColliderMetadata>()
let paused = false
let timingEnabled = false
let lastTimingSequence = -1

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const parsed = parseWorldPhysicsMainMessage(event.data)
  if (!parsed.success) {
    postError('invalid-main-message', parsed.issue, generationId || 1)
    return
  }
  const message = parsed.value
  if (message.kind === 'init') {
    if (initializingGenerationId !== null) {
      postError('physics-init-busy', `Physics generation ${initializingGenerationId} is still initializing.`, message.generationId)
      return
    }
    initializingGenerationId = message.generationId
    void initialize(message.generationId, message.scene, message.diagnostics)
      .catch((error) => {
        disposeWorld()
        postError('physics-init-failed', error instanceof Error ? error.message : 'Rapier initialization failed.', message.generationId)
      })
      .finally(() => {
        if (initializingGenerationId === message.generationId) initializingGenerationId = null
      })
    return
  }
  if (message.generationId !== generationId || !world) return
  try {
    if (message.kind === 'pause') paused = true
    else if (message.kind === 'resume') paused = false
    else if (message.kind === 'dispose') disposeWorld()
    else if (message.kind === 'step' && !paused) {
      if (timingEnabled && message.sequence <= lastTimingSequence) throw new Error('Diagnostic step sequences must increase within a generation.')
      if (timingEnabled) lastTimingSequence = message.sequence
      stepWorld(message.sequence, message.steps)
    }
  } catch (error) {
    postError('physics-step-failed', error instanceof Error ? error.message : 'Rapier step failed.', message.generationId)
  }
})

async function initialize(nextGenerationId: number, scene: Parameters<typeof createWorld>[0], diagnostics?: true): Promise<void> {
  RAPIER = await loadRapier()
  disposeWorld()
  generationId = nextGenerationId
  timingEnabled = diagnostics === true
  paused = false
  createWorld(scene)
  scope.postMessage({
    version: WORLD_PHYSICS_PROTOCOL_VERSION,
    kind: 'ready',
    generationId,
    entityIds: bodies.map((runtime) => runtime.dto.entityId),
  })
}

function loadRapier(): Promise<RapierApi> {
  rapierLoadPromise ??= import('@dimforge/rapier3d').then((module) => module.default)
  return rapierLoadPromise
}

function createWorld(scene: import('./worldPhysicsProtocol.ts').WorldPhysicsSceneDto): void {
  world = new RAPIER.World({ x: scene.gravity[0], y: scene.gravity[1], z: scene.gravity[2] })
  world.timestep = WORLD_FIXED_STEP_SECONDS
  eventQueue = new RAPIER.EventQueue(true)
  bodies = []
  bodiesByEntity = new Map()
  colliderMetadata = new Map()
  for (const dto of scene.bodies) {
    const body = world.createRigidBody(createRigidBodyDesc(dto))
    const colliders = new Map<string, RAPIER_TYPES.Collider>()
    for (const colliderDto of dto.colliders) {
      const collider = world.createCollider(createColliderDesc(colliderDto, dto.bodyType), body)
      colliders.set(colliderDto.componentId, collider)
      colliderMetadata.set(collider.handle, {
        entityId: dto.entityId,
        tags: [...dto.tags],
        triggerComponentIds: [...colliderDto.triggerComponentIds],
      })
    }
    const runtime: RuntimeBody = { dto, body, character: null }
    if (dto.controller) {
      const collider = colliders.get(dto.controller.colliderComponentId)
      if (!collider) throw new Error(`Character collider ${dto.controller.colliderComponentId} is unavailable.`)
      const controller = world.createCharacterController(0.01)
      controller.setMaxSlopeClimbAngle(dto.controller.maxSlopeRadians)
      controller.enableSnapToGround(0.15)
      controller.setApplyImpulsesToDynamicBodies(true)
      runtime.character = { input: dto.controller, collider, controller, verticalVelocity: 0, grounded: false }
    }
    bodies.push(runtime)
    bodiesByEntity.set(dto.entityId, runtime)
  }
}

function createRigidBodyDesc(dto: WorldPhysicsBodyDto): RAPIER_TYPES.RigidBodyDesc {
  const desc = dto.bodyType === 'dynamic' ? RAPIER.RigidBodyDesc.dynamic()
    : dto.bodyType === 'kinematic-position' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
      : dto.bodyType === 'kinematic-velocity' ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
        : RAPIER.RigidBodyDesc.fixed()
  return desc
    .setTranslation(dto.position[0], dto.position[1], dto.position[2])
    .setRotation({ x: dto.rotation[0], y: dto.rotation[1], z: dto.rotation[2], w: dto.rotation[3] })
    .setGravityScale(dto.gravityScale)
    .setLinearDamping(dto.linearDamping)
    .setAngularDamping(dto.angularDamping)
    .setCanSleep(dto.canSleep)
    .setUserData({ entityId: dto.entityId })
}

function createColliderDesc(dto: WorldPhysicsColliderDto, bodyType: WorldPhysicsBodyDto['bodyType']): RAPIER_TYPES.ColliderDesc {
  const desc = createColliderShapeDesc(dto, bodyType)
  if (dto.sensor && bodyType === 'fixed') {
    desc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED)
  }
  return desc
    .setSensor(dto.sensor)
    .setFriction(dto.friction)
    .setRestitution(dto.restitution)
    .setCollisionGroups(((dto.collisionLayer * 0x10000) + dto.collisionMask) >>> 0)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
}

function createColliderShapeDesc(dto: WorldPhysicsColliderDto, bodyType: WorldPhysicsBodyDto['bodyType']): RAPIER_TYPES.ColliderDesc {
  if (dto.shape.kind === 'box') return RAPIER.ColliderDesc.cuboid(dto.shape.halfExtents[0], dto.shape.halfExtents[1], dto.shape.halfExtents[2])
  if (dto.shape.kind === 'sphere') return RAPIER.ColliderDesc.ball(dto.shape.radius)
  if (dto.shape.kind === 'capsule') return RAPIER.ColliderDesc.capsule(dto.shape.halfHeight, dto.shape.radius)
  if (dto.shape.kind === 'trimesh') {
    if (bodyType !== 'fixed') throw new Error(`Static mesh collider ${dto.componentId} requires a fixed body.`)
    return RAPIER.ColliderDesc.trimesh(dto.shape.vertices, dto.shape.indices)
  }
  const desc = RAPIER.ColliderDesc.convexHull(dto.shape.vertices)
  if (!desc) throw new Error(`Convex hull collider ${dto.componentId} could not be built from the provided geometry.`)
  return desc
}

function stepWorld(
  sequence: number,
  steps: readonly WorldPhysicsFixedStep[],
): void {
  if (!world || !eventQueue) return
  const applyImpulse = (impulse: WorldPhysicsFixedStep['impulses'][number]) => {
    const runtime = bodiesByEntity.get(impulse.entityId)
    if (runtime?.dto.bodyType === 'dynamic') runtime.body.applyImpulse({ x: impulse.impulse[0], y: impulse.impulse[1], z: impulse.impulse[2] }, true)
  }
  const triggerEvents: WorldPhysicsTriggerEvent[] = []
  const stepTimings: WorldPhysicsStepTiming[] | undefined = timingEnabled ? [] : undefined
  // Start before the helper's impulse phase, including on every following substep.
  let stepStartedAt = stepTimings ? performance.now() : 0
  executeWorldPhysicsFixedSteps(steps, applyImpulse, (step, substep) => {
    const inputByEntity = new Map(step.characters.map((input) => [input.entityId, input]))
    for (const runtime of bodies) if (runtime.character) applyCharacterMovement(runtime, inputByEntity.get(runtime.dto.entityId), true)
    const solverStartedAt = stepTimings ? performance.now() : 0
    world!.step(eventQueue!)
    const solverMs = stepTimings ? performance.now() - solverStartedAt : 0
    drainTriggerEvents(eventQueue!, triggerEvents)
    if (stepTimings) {
      stepTimings.push({ substep, solverMs, physicsStepMs: performance.now() - stepStartedAt })
      if (substep + 1 < steps.length) stepStartedAt = performance.now()
    }
  })
  const transforms = new Float32Array(bodies.length * WORLD_PHYSICS_TRANSFORM_STRIDE)
  for (const [index, runtime] of bodies.entries()) {
    const translation = runtime.body.translation()
    const rotation = runtime.body.rotation()
    const offset = index * WORLD_PHYSICS_TRANSFORM_STRIDE
    transforms[offset] = translation.x
    transforms[offset + 1] = translation.y
    transforms[offset + 2] = translation.z
    transforms[offset + 3] = rotation.x
    transforms[offset + 4] = rotation.y
    transforms[offset + 5] = rotation.z
    transforms[offset + 6] = rotation.w
  }
  const message = {
    version: WORLD_PHYSICS_PROTOCOL_VERSION,
    kind: 'snapshot' as const,
    generationId,
    sequence,
    entityIds: bodies.map((runtime) => runtime.dto.entityId),
    transforms: transforms.buffer,
    triggerEvents,
    ...(stepTimings ? { stepTimings } : {}),
  }
  scope.postMessage(message, [transforms.buffer])
}

function applyCharacterMovement(runtime: RuntimeBody, input: WorldPhysicsCharacterInput | undefined, allowJumpEdge: boolean): void {
  const character = runtime.character
  if (!character) return
  if (allowJumpEdge && input?.jumpPressed && character.grounded) character.verticalVelocity = character.input.jumpSpeed
  else if (!character.grounded) character.verticalVelocity -= 9.81 * WORLD_FIXED_STEP_SECONDS
  const move = input?.move ?? [0, 0]
  const desired = {
    x: move[0] * character.input.speed * WORLD_FIXED_STEP_SECONDS,
    y: character.verticalVelocity * WORLD_FIXED_STEP_SECONDS,
    z: -move[1] * character.input.speed * WORLD_FIXED_STEP_SECONDS,
  }
  character.controller.computeColliderMovement(character.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS)
  const movement = character.controller.computedMovement()
  const current = runtime.body.translation()
  runtime.body.setNextKinematicTranslation({ x: current.x + movement.x, y: current.y + movement.y, z: current.z + movement.z })
  character.grounded = character.controller.computedGrounded()
  if (character.grounded && character.verticalVelocity < 0) character.verticalVelocity = 0
}

function drainTriggerEvents(queue: RAPIER_TYPES.EventQueue, output: WorldPhysicsTriggerEvent[]): void {
  const dedupe = new Set(output.map(triggerEventKey))
  queue.drainCollisionEvents((leftHandle, rightHandle, started) => {
    const left = colliderMetadata.get(leftHandle)
    const right = colliderMetadata.get(rightHandle)
    if (!left || !right || left.entityId === right.entityId) return
    emitTriggerSide(left, right, started, output, dedupe)
    emitTriggerSide(right, left, started, output, dedupe)
  })
}

function emitTriggerSide(triggerSide: RuntimeColliderMetadata, other: RuntimeColliderMetadata, started: boolean, output: WorldPhysicsTriggerEvent[], dedupe: Set<string>): void {
  for (const triggerComponentId of triggerSide.triggerComponentIds) {
    const event: WorldPhysicsTriggerEvent = {
      type: started ? 'enter' : 'exit',
      triggerComponentId,
      otherEntityId: other.entityId,
      otherTags: [...other.tags],
    }
    const key = triggerEventKey(event)
    if (dedupe.has(key)) continue
    dedupe.add(key)
    output.push(event)
  }
}

function triggerEventKey(event: WorldPhysicsTriggerEvent): string {
  return `${event.type}\0${event.triggerComponentId}\0${event.otherEntityId}`
}

function disposeWorld(): void {
  world?.free()
  eventQueue?.free()
  world = null
  eventQueue = null
  bodies = []
  bodiesByEntity.clear()
  colliderMetadata.clear()
  paused = false
  timingEnabled = false
  lastTimingSequence = -1
}

function postError(code: string, message: string, targetGeneration: number): void {
  scope.postMessage({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'error', generationId: targetGeneration, code, message })
}
