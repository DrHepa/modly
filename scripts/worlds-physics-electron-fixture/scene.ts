import { applyWorldCommandBatch, type WorldCommand, type WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1, type WorldVector3 } from '../../src/areas/worlds/core/worldModel.ts'
import { buildAddEmptyEntityCommands, buildComponentPresetCommands, type WorldComponentPreset } from '../../src/areas/worlds/editor/worldAuthoringModel.ts'
import { buildAddCameraCommands, createDeterministicWorldEditorIdentityGenerator } from '../../src/areas/worlds/editor/worldEditorCommandBuilders.ts'
import { ENTITY_NAMES } from './shared.ts'
import { createDefaultWorldComponent } from '../../src/areas/worlds/core/worldComponentRegistry.ts'

/** Author through the same validated command builders as the editor; never construct a Rapier world. */
export function createPhysicsFixtureBatches(initial: WorldProjectSnapshotV1, projectKey: string, scenario?: 'acceptance-500'): WorldCommandBatchV1[] {
  if (scenario !== undefined && scenario !== 'acceptance-500') throw new TypeError('Unsupported physics fixture scenario.')
  let snapshot = initial
  const identities = createDeterministicWorldEditorIdentityGenerator('worlds-physics-phase1')
  const batches: WorldCommandBatchV1[] = []
  const context = () => ({ snapshot, projectKey, activeSceneId: snapshot.project.startSceneId, identities })
  const append = (commands: WorldCommand[], transactionId = `tx:physics-fixture-seed-${batches.length + 1}`) => {
    const batch: WorldCommandBatchV1 = {
      schema: WORLD_COMMAND_BATCH_SCHEMA, transactionId,
      origin: 'ui', projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, commands,
    }
    const preview = applyWorldCommandBatch(snapshot, batch)
    if (!preview.success) throw new Error(`Physics fixture authoring rejected: ${JSON.stringify(preview.issues)}`)
    snapshot = preview.snapshot
    batches.push(batch)
  }
  append(buildAddCameraCommands(context(), { name: 'Physics camera', transform: { position: [5, 5, 9], rotation: [-0.3, 0.3, 0], scale: [1, 1, 1] } }))
  const entity = (name: string, preset: WorldComponentPreset, position: WorldVector3, scale: WorldVector3) => {
    const [add] = buildAddEmptyEntityCommands(context(), { name })
    append([add])
    append(buildComponentPresetCommands(context(), add.entity.id, preset))
    append([{ type: 'patch-entity', sceneId: snapshot.project.startSceneId, entityId: add.entity.id, patch: {
      transform: { position, rotation: [0, 0, 0], scale },
      ...(preset === 'character' ? { tags: ['physics-character'] } : {}),
    } }])
  }
  entity(ENTITY_NAMES.ground, 'fixed-body', [0, -0.5, 0], [20, 1, 12])
  entity(ENTITY_NAMES.character, 'character', [0, 1, 0], [1, 1, 1])
  // A sensor without a rigid-body component intentionally projects to a fixed body.
  entity(ENTITY_NAMES.sensor, 'trigger', [1.2, 1, 0], [0.4, 3, 2])
  entity(ENTITY_NAMES.platform, 'fixed-body', [3.25, 0.5, 0], [1.5, 1, 2])
  if (scenario === 'acceptance-500') for (let batch = 0; batch < 10; batch += 1) {
    const commands = Array.from({ length: 50 }, (_, offset): WorldCommand => {
      const n = batch * 50 + offset, suffix = String(n).padStart(3, '0')
      const rigidBody = createDefaultWorldComponent('rigid-body', `rigid-body:physics-load-${suffix}`)
      const collider = createDefaultWorldComponent('collider', `collider:physics-load-${suffix}`)
      if (rigidBody.type !== 'rigid-body' || collider.type !== 'collider' || collider.shape !== 'box') {
        throw new TypeError('Physics fixture defaults must be rigid-body and box collider components.')
      }
      return { type: 'add-entity', sceneId: snapshot.project.startSceneId, entity: {
        id: `entity:physics-load-${suffix}`, name: `Physics load ${suffix}`, parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [-8 + 0.5 * (n % 10), 0.3 + 0.5 * Math.floor(n / 100), 0.5 + 0.5 * (Math.floor(n / 10) % 10)], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [
          { ...rigidBody, canSleep: false },
          { ...collider, halfExtents: [0.2, 0.2, 0.2] },
        ],
      } }
    })
    append(commands, `tx:physics-load-${String(batch + 1).padStart(2, '0')}`)
  }
  return batches
}
