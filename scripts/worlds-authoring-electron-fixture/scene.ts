import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { WorldProjectRepository } from '../../electron/main/world-project-repository.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldCommand, WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { buildAddModelEntityCommands, buildAddSceneCommands, createDeterministicWorldEditorIdentityGenerator } from '../../src/areas/worlds/editor/worldEditorCommandBuilders.ts'
import { NAMES, PROJECT_ID, PROJECT_KEY, SCENE_ID, type SeedEvidence } from './shared.ts'

export const ASSET_PATHS = ['AuthoringFixtures/red-cube.glb', 'AuthoringFixtures/blue-pyramid.glb'] as const
export const UI_ASSET_PATHS = ['Exports/AuthoringFixtures/red-cube.glb', 'Exports/AuthoringFixtures/blue-pyramid.glb'] as const

/** Input provisioning only: no canonical project, scene, entity or command is created. */
export async function provisionAuthoringInputs(workspace: string): Promise<void> {
  await mkdir(path.join(workspace, 'Exports', 'AuthoringFixtures'), { recursive: true, mode: 0o700 })
  for (const [index, relative] of UI_ASSET_PATHS.entries()) await writeFile(path.join(workspace, relative), makeGlb(index === 1), { flag: 'wx', mode: 0o600 })
}

/** Self-contained, non-indexed glTF 2.0 geometry; no external buffers, images, or downloads. */
function makeGlb(pyramid: boolean): Buffer {
  const p: [number, number, number][] = pyramid
    ? [[-0.42, 0, -0.42], [0.42, 0, -0.42], [0.42, 0, 0.42], [-0.42, 0, 0.42], [0, 1.0, 0]]
    : [[-0.35, 0, -0.35], [0.35, 0, -0.35], [0.35, 0.7, -0.35], [-0.35, 0.7, -0.35], [-0.35, 0, 0.35], [0.35, 0, 0.35], [0.35, 0.7, 0.35], [-0.35, 0.7, 0.35]]
  const faces = pyramid
    ? [[0, 2, 1], [0, 3, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]
    : [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const positions: number[] = [], normals: number[] = []
  for (const face of faces) {
    const [a, b, c] = face.map((i) => p[i])
    const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i])
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const length = Math.hypot(...normal)
    assert.ok(length > 0)
    for (const point of [a, b, c]) { positions.push(...point); normals.push(...normal.map((value) => value / length)) }
  }
  const positionBytes = Buffer.alloc(positions.length * 4), normalBytes = Buffer.alloc(normals.length * 4)
  positions.forEach((value, i) => positionBytes.writeFloatLE(value, i * 4))
  normals.forEach((value, i) => normalBytes.writeFloatLE(value, i * 4))
  const bin = Buffer.concat([positionBytes, normalBytes])
  const document = {
    asset: { version: '2.0', generator: 'Modly native authoring deterministic fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: pyramid ? 'Seed pyramid geometry' : 'Seed cube geometry', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0, mode: 4 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: pyramid ? [0.04, 0.12, 0.95, 1] : [0.95, 0.04, 0.02, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 }, { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length, target: 34962 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [0, 1, 2].map((axis) => Math.min(...p.map((point) => point[axis]))), max: [0, 1, 2].map((axis) => Math.max(...p.map((point) => point[axis]))) },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    ],
  }
  const raw = Buffer.from(JSON.stringify(document)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20)
  raw.copy(json)
  const result = Buffer.alloc(12 + 8 + json.length + 8 + bin.length)
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8)
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20)
  const offset = 20 + json.length
  result.writeUInt32LE(bin.length, offset); result.writeUInt32LE(0x004e4942, offset + 4); bin.copy(result, offset + 8)
  assert.equal(result.length % 4, 0)
  return result
}

/** Every canonical seed change is SETUP through the unchanged disk repository. */
export async function seedAuthoring(repository: WorldProjectRepository, workspace: string, record: (value: unknown) => void): Promise<SeedEvidence> {
  await mkdir(path.join(workspace, 'AuthoringFixtures'), { mode: 0o700 })
  for (const [index, relative] of ASSET_PATHS.entries()) await writeFile(path.join(workspace, relative), makeGlb(index === 1), { flag: 'wx', mode: 0o600 })
  const created = await repository.create({ name: 'Native authoring fixture', initialSceneName: 'Authoring scene', projectId: PROJECT_ID, initialSceneId: SCENE_ID })
  record({ phase: 'SETUP', operation: 'create', result: created, at: new Date().toISOString() })
  assert.ok(created.ok, JSON.stringify(created))
  assert.deepEqual(created.value.durabilityWarnings, [])
  let snapshot: WorldProjectSnapshotV1 = created.value.snapshot
  let index = 0
  const identities = createDeterministicWorldEditorIdentityGenerator('native-authoring-seed')
  const context = (sceneId = SCENE_ID) => ({ snapshot, projectKey: PROJECT_KEY, activeSceneId: sceneId, identities })
  const append = async (commands: WorldCommand[]) => {
    const batch: WorldCommandBatchV1 = { schema: WORLD_COMMAND_BATCH_SCHEMA, transactionId: `tx:native-authoring-setup-${++index}`, projectId: PROJECT_ID, baseRevision: snapshot.project.revision, origin: 'ui', commands }
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY, batch })
    record({ phase: 'SETUP', operation: 'applyCommands', request: { projectKey: PROJECT_KEY, batch }, result, at: new Date().toISOString() })
    assert.ok(result.ok, JSON.stringify(result)); assert.deepEqual(result.value.warnings, [])
    snapshot = result.value.snapshot
  }
  const second = buildAddSceneCommands(context(), { name: 'Untouched second scene' })
  await append(second)
  const sentinelSceneId = second[0].scene.sceneId
  const addModel = async (name: string, assetIndex: number, sceneId: string, x: number) => {
    const commands = buildAddModelEntityCommands(context(sceneId), { name, workspacePath: ASSET_PATHS[assetIndex], format: 'glb', transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } })
    const add = commands.find((command) => command.type === 'add-entity')
    assert.ok(add?.type === 'add-entity')
    // The production renderable material overrides GLB material colors. Declare seed colors in that canonical component.
    const component = add.entity.components.find((value) => value.type === 'renderable')
    assert.ok(component?.type === 'renderable')
    component.material = { baseColor: assetIndex === 0 ? '#ed3021' : '#164bea', metallic: 0, roughness: 1, opacity: 1 }
    await append(commands)
    return add.entity.id
  }
  const aId = await addModel(NAMES.a, 0, SCENE_ID, -1.25)
  const bId = await addModel(NAMES.b, 1, SCENE_ID, 1.25)
  await addModel(NAMES.sentinel, 1, sentinelSceneId, 9)
  const scene = snapshot.scenes.find((value) => value.sceneId === SCENE_ID)!
  const reference = snapshot.project.scenes.find((value) => value.id === SCENE_ID)!
  await append([{ type: 'replace-scene', sceneId: SCENE_ID, reference, scene: { ...structuredClone(scene), editor: { initialView: { position: [4.4, 3.1, 7.4], target: [0, 0.5, 0] } } } }])
  return { snapshot, aId, bId, sentinelSceneId }
}
