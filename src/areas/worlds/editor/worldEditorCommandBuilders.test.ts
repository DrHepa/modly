import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import type { WorldComponent } from '../core/worldComponentRegistry.ts'
import type { WorldCommand } from '../core/worldCommands.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import {
  buildAddCameraCommands,
  buildAddLightCommands,
  buildAddModelEntityCommands,
  buildAddSceneCommands,
  buildCascadeDeleteCommands,
  buildDuplicateSubtreesCommands,
  buildPatchEntityTransformsCommands,
  buildReparentEntityCommands,
  buildSetEntitiesEnabledCommands,
  buildSetEntitiesLockedCommands,
  buildSetRenderableVisibilityCommands,
  buildWorldSnapshotTransitionCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from './worldEditorCommandBuilders.ts'

const projectKey = `world-${'a'.repeat(32)}`

function apply(snapshot: WorldProjectSnapshotV1, commands: WorldCommand[], transactionId = 'tx:builders') {
  return applyWorldCommandBatch(snapshot, {
    schema: 'modly.world-command-batch.v1',
    transactionId,
    projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision,
    origin: 'ui',
    commands,
  })
}

test('scene, model, camera and light builders produce repository-confined atomic commands', () => {
  const snapshot = createValidWorldSnapshot()
  const identities = createDeterministicWorldEditorIdentityGenerator('builder-test')
  const sceneCommands = buildAddSceneCommands({ snapshot, projectKey, identities }, { name: 'Third scene' })
  assert.equal(sceneCommands.length, 1)
  assert.match(sceneCommands[0].reference.documentPath, new RegExp(`^Worlds/${projectKey}/scenes/scene-[a-f0-9]{32}\\.world-scene\\.json$`))
  const sceneApplied = apply(snapshot, sceneCommands)
  assert.equal(sceneApplied.success, true)
  if (!sceneApplied.success) return

  const sceneId = sceneCommands[0].scene.sceneId
  const modelCommands = buildAddModelEntityCommands(
    { snapshot: sceneApplied.snapshot, projectKey, activeSceneId: sceneId, identities },
    { workspacePath: 'Workflows/models/ship.glb', format: 'glb', name: 'Ship' },
  )
  assert.deepEqual(modelCommands.map((command) => command.type), ['add-resource', 'add-entity'])
  const modelApplied = apply(sceneApplied.snapshot, modelCommands, 'tx:model')
  assert.equal(modelApplied.success, true)
  if (!modelApplied.success) return

  const reused = buildAddModelEntityCommands(
    { snapshot: modelApplied.snapshot, projectKey, activeSceneId: sceneId, identities },
    { workspacePath: 'Workflows/models/ship.glb', format: 'glb', name: 'Ship copy' },
  )
  assert.deepEqual(reused.map((command) => command.type), ['add-entity'])

  const camera = buildAddCameraCommands(
    { snapshot: modelApplied.snapshot, projectKey, activeSceneId: sceneId, identities },
    { name: 'Main camera' },
  )
  assert.equal(camera[0].type, 'add-entity')
  if (camera[0].type === 'add-entity') {
    const component = camera[0].entity.components[0]
    assert.equal(component.type, 'camera')
    if (component.type === 'camera') assert.equal(component.primary, true)
  }
  const light = buildAddLightCommands(
    { snapshot: modelApplied.snapshot, projectKey, activeSceneId: sceneId, identities },
    { name: 'Key', lightKind: 'directional' },
  )
  assert.equal(light[0].type, 'add-entity')
})

test('selection builders are deterministic and locked edits fail through the command bus', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities.push({
    id: 'entity:prop', name: 'Prop', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [],
  })
  const transforms = buildPatchEntityTransformsCommands(snapshot, 'scene:one', [
    { entityId: 'entity:prop', transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { entityId: 'entity:hero', transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ])
  assert.deepEqual(transforms.map((command) => command.type === 'patch-entity' ? command.entityId : ''), ['entity:hero', 'entity:prop'])
  assert.equal(apply(snapshot, transforms).success, true)
  assert.deepEqual(buildReparentEntityCommands(snapshot, 'scene:one', 'entity:prop', 'entity:hero'), [
    { type: 'reparent-entity', sceneId: 'scene:one', entityId: 'entity:prop', parentId: 'entity:hero' },
  ])
  assert.equal(buildSetEntitiesEnabledCommands(snapshot, 'scene:one', ['entity:prop'], false)[0].type, 'patch-entity')
  assert.equal(buildSetRenderableVisibilityCommands(snapshot, 'scene:one', ['entity:hero'], false)[0].type, 'replace-component')
  assert.equal(buildSetEntitiesLockedCommands(snapshot, 'scene:one', ['entity:hero'], true)[0].type, 'patch-entity')
  assert.equal(buildCascadeDeleteCommands(snapshot, 'scene:one', ['entity:hero'])[0].type, 'remove-entity')

  snapshot.scenes[0].entities[0].locked = true
  assert.equal(apply(snapshot, buildSetRenderableVisibilityCommands(snapshot, 'scene:one', ['entity:hero'], false), 'tx:locked').success, false)
})

test('duplicate subtree remaps every internal entity, component, trigger and behavior reference', () => {
  const snapshot = createValidWorldSnapshot()
  const childComponents: WorldComponent[] = [
    { id: 'component:child-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: true, friction: 0.5, restitution: 0 },
    { id: 'component:child-trigger', type: 'trigger', enabled: true, colliderComponentId: 'component:child-collider', once: false, targetTags: [] },
    {
      id: 'component:child-behavior', type: 'behavior', enabled: true,
      bindings: [{
        id: 'binding:child', event: { type: 'trigger-enter', triggerComponentId: 'component:child-trigger' },
        actions: [
          { type: 'set-visibility', entityId: 'entity:hero', visible: false },
          { type: 'set-component-property', entityId: 'entity:hero', componentId: 'component:hero-renderable', componentType: 'renderable', property: 'visible', value: false },
        ],
      }],
    },
  ]
  snapshot.scenes[0].entities.push({
    id: 'entity:child', name: 'Child', parentId: 'entity:hero', enabled: true, locked: false, tags: [],
    transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: childComponents,
  })
  const identities = createDeterministicWorldEditorIdentityGenerator('duplicate')
  const commands = buildDuplicateSubtreesCommands(snapshot, 'scene:one', ['entity:hero'], identities)
  assert.equal(commands.length, 2)
  const entities = commands.map((command) => command.type === 'add-entity' ? command.entity : null).filter((value) => value !== null)
  const duplicatedRoot = entities.find((entity) => entity.parentId === null)!
  const duplicatedChild = entities.find((entity) => entity.parentId === duplicatedRoot.id)!
  const trigger = duplicatedChild.components.find((component) => component.type === 'trigger')
  const behavior = duplicatedChild.components.find((component) => component.type === 'behavior')
  assert.equal(trigger?.type, 'trigger')
  if (trigger?.type === 'trigger') assert.notEqual(trigger.colliderComponentId, 'component:root-collider')
  assert.equal(behavior?.type, 'behavior')
  if (behavior?.type === 'behavior') {
    const binding = behavior.bindings[0]
    assert.notEqual(binding.id, 'binding:child')
    assert.notEqual(binding.event.type === 'trigger-enter' ? binding.event.triggerComponentId : '', 'component:child-trigger')
    assert.equal(binding.actions[0].type === 'set-visibility' ? binding.actions[0].entityId : '', duplicatedRoot.id)
    assert.equal(binding.actions[1].type === 'set-component-property' ? binding.actions[1].entityId : '', duplicatedRoot.id)
    assert.notEqual(binding.actions[1].type === 'set-component-property' ? binding.actions[1].componentId : '', 'component:hero-renderable')
  }
  assert.equal(apply(snapshot, commands, 'tx:duplicate').success, true)
})

test('snapshot transition commands restore complete content while revision remains monotonic', () => {
  const current = createValidWorldSnapshot()
  const target = structuredClone(current)
  current.project.name = 'Current'
  current.scenes[0].entities[0].locked = true
  target.project.name = 'Target'
  target.project.revision = current.project.revision + 1
  target.scenes[0].entities[0].locked = false
  target.scenes[0].entities[0].transform.position = [9, 8, 7]
  const commands = buildWorldSnapshotTransitionCommands(current, target)
  assert.equal(commands[0].type, 'patch-entity')
  const result = apply(current, commands, 'tx:transition')
  assert.equal(result.success, true)
  if (result.success) assert.deepEqual(result.snapshot, target)
})

test('snapshot transition leaves unchanged locks untouched for project-only history and restores locks after scene edits', () => {
  const current = createValidWorldSnapshot()
  current.scenes[0].entities[0].locked = true

  const renamed = structuredClone(current)
  renamed.project.revision += 1
  renamed.project.name = 'Renamed while locked'
  const renameCommands = buildWorldSnapshotTransitionCommands(current, renamed)
  assert.deepEqual(renameCommands, [{ type: 'rename-project', name: 'Renamed while locked' }])
  const renameResult = apply(current, renameCommands, 'tx:locked-rename')
  assert.equal(renameResult.success, true)
  if (renameResult.success) assert.deepEqual(renameResult.snapshot, renamed)

  const sceneTarget = structuredClone(current)
  sceneTarget.project.revision += 1
  sceneTarget.scenes[0].environment.backgroundColor = '#123456'
  const sceneCommands = buildWorldSnapshotTransitionCommands(current, sceneTarget)
  assert.deepEqual(sceneCommands.map((command) => command.type), ['patch-entity', 'replace-scene'])
  const sceneResult = apply(current, sceneCommands, 'tx:locked-scene')
  assert.equal(sceneResult.success, true)
  if (sceneResult.success) assert.deepEqual(sceneResult.snapshot, sceneTarget)
})
