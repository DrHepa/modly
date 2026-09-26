import assert from 'node:assert/strict'
import test from 'node:test'

import { createValidWorldSnapshot } from '../worlds/core/_testFixtures.ts'
import type { WorldCommand } from '../worlds/core/worldCommands.ts'
import {
  buildAddModelEntityCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from '../worlds/editor/worldEditorCommandBuilders.ts'
import type { WorldEditorCommandPort } from '../worlds/editor/worldEditorCommandPort.ts'
import type { LegacyWorldsCommandBridge } from '../worlds/editor/legacyWorldsCommandBridge.ts'
import type { WorldEditorDispatchAuthority } from '../worlds/editor/worldEditorController.ts'
import { routeWorkflowOutputToWorlds, type WorkflowWorldsOutputContext } from './workflowWorldsOutput.ts'

const projectKey = `world-${'d'.repeat(32)}`
const worldSculptWorkspacePath = 'Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb'
const worldSculptOutputUrl = `/workspace/${worldSculptWorkspacePath}`
const privateHostSentinel = 'private-host-root-must-not-escape'
const worldSculptContext = {
  runId: 'run:worldsculpt',
  sourceNodeId: 'node:worldsculpt',
  targetNodeId: 'node:add-to-worlds',
  artifactId: 'artifact:worldsculpt-scene',
} satisfies WorkflowWorldsOutputContext

function canonicalWorldsWorkflowDependencies() {
  const snapshot = createValidWorldSnapshot()
  const calls: Array<{ transactionId: string; origin: string; commands: WorldCommand[]; authority?: WorldEditorDispatchAuthority }> = []
  const commandPort = {
    getActiveContext: () => ({
      projectKey,
      projectId: snapshot.project.projectId,
      baseRevision: snapshot.project.revision,
      activeSceneId: 'scene:one',
      snapshot,
    }),
    async dispatchCommands(request: { transactionId: string; origin: string; commands: WorldCommand[] }, authority?: WorldEditorDispatchAuthority) {
      calls.push(structuredClone({ ...request, authority }))
      return {
        ok: true as const,
        value: {
          transactionId: request.transactionId,
          revision: 5,
          idempotent: calls.length > 1,
          changes: [],
          warnings: [],
          receipt: {
            transactionId: request.transactionId,
            payloadSha256: 'a'.repeat(64),
            resultSha256: 'b'.repeat(64),
            appliedRevision: 5,
          },
        },
      }
    },
  } as unknown as WorldEditorCommandPort
  const legacyCalls: string[] = []
  const legacyBridge = {
    async appendRenderable() { legacyCalls.push('append'); return { accepted: true as const, mode: 'legacy' as const } },
    async replaceScene() { legacyCalls.push('replace'); return { accepted: true as const, mode: 'legacy' as const } },
  } satisfies LegacyWorldsCommandBridge
  return {
    calls,
    legacyCalls,
    dependencies: {
      commandPort,
      legacyBridge,
      getApiUrl: () => `http://127.0.0.1:8765/${privateHostSentinel}`,
      fetchManifest: async (): Promise<Response> => { throw new Error('WorldSculpt GLB route must not fetch scene manifests') },
      resolvePlyKind: async () => undefined,
    },
  }
}

function buildExpectedWorldSculptCommands(
  workspacePath: string,
  context: WorkflowWorldsOutputContext,
): WorldCommand[] {
  const snapshot = createValidWorldSnapshot()
  const identitySeed = [
    snapshot.project.projectId,
    'scene:one',
    context.runId ?? '',
    context.sourceNodeId ?? '',
    context.targetNodeId ?? '',
    context.artifactId ?? '',
    context.sceneMode ?? 'replace',
    'mesh',
    workspacePath,
  ].join('\0')
  return buildAddModelEntityCommands({
    snapshot,
    projectKey,
    activeSceneId: 'scene:one',
    identities: createDeterministicWorldEditorIdentityGenerator(identitySeed),
  }, {
    workspacePath,
    format: 'glb',
    name: workspacePath.split('/').at(-1) ?? workspacePath,
  })
}

test('WorldSculpt workflow GLB routes through canonical workflow model commands', async () => {
  const fixture = canonicalWorldsWorkflowDependencies()
  const expectedCommands = buildExpectedWorldSculptCommands(worldSculptWorkspacePath, worldSculptContext)
  const independentlyExpectedCommands = buildExpectedWorldSculptCommands(worldSculptWorkspacePath, worldSculptContext)

  assert.deepEqual(independentlyExpectedCommands, expectedCommands)
  assert.equal(expectedCommands[0]?.type, 'add-resource')
  assert.equal(expectedCommands[1]?.type, 'add-entity')
  if (expectedCommands[0]?.type !== 'add-resource' || expectedCommands[1]?.type !== 'add-entity') return
  assert.equal(expectedCommands[0].resource.id, 'resource:51fc6973939418dcd6d045ef1f67caa2')
  assert.equal(expectedCommands[1].entity.id, 'entity:a38ce36235f7626d812ce7aec3936b6f')
  assert.equal(expectedCommands[1].entity.components[0]?.id, 'component:cb44b99c7d0a0a1586e075a8173c73bb')

  const first = await routeWorkflowOutputToWorlds(worldSculptOutputUrl, 'mesh', worldSculptContext, fixture.dependencies)

  assert.equal(first.accepted && first.mode, 'canonical')
  assert.equal(fixture.legacyCalls.length, 0)
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0].origin, 'workflow')
  assert.equal(fixture.calls[0].transactionId, 'tx:workflow:00f274264ac5543d4aa300d213279bdf')
  assert.deepEqual(fixture.calls[0].commands, expectedCommands)
  assert.deepEqual(fixture.calls[0].authority, {
    projectKey,
    projectId: 'project:demo',
    baseRevision: 4,
    activeSceneId: 'scene:one',
  })

  const [addResource, addEntity] = fixture.calls[0].commands
  assert.equal(addResource.type, 'add-resource')
  assert.equal(addEntity.type, 'add-entity')
  if (addResource.type !== 'add-resource' || addEntity.type !== 'add-entity') return

  assert.deepEqual(addResource.resource, {
    id: 'resource:51fc6973939418dcd6d045ef1f67caa2',
    type: 'model',
    name: 'scene.glb',
    workspacePath: worldSculptWorkspacePath,
    format: 'glb',
  })
  assert.equal(addEntity.sceneId, 'scene:one')
  assert.equal(addEntity.entity.id, 'entity:a38ce36235f7626d812ce7aec3936b6f')
  assert.equal(addEntity.entity.name, 'scene.glb')
  assert.equal(addEntity.entity.components.length, 1)
  assert.deepEqual(addEntity.entity.components[0], {
    id: 'component:cb44b99c7d0a0a1586e075a8173c73bb',
    type: 'renderable',
    enabled: true,
    resourceId: 'resource:51fc6973939418dcd6d045ef1f67caa2',
    visible: true,
    castShadow: true,
    receiveShadow: true,
    material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
  })
  assert.equal(JSON.stringify(fixture.calls[0]).includes(privateHostSentinel), false)
  assert.equal(JSON.stringify(fixture.calls[0]).includes('/workspace/'), false)

  const changedOutputUrl = '/workspace/Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene-alt.glb'
  await routeWorkflowOutputToWorlds(changedOutputUrl, 'mesh', worldSculptContext, fixture.dependencies)
  assert.equal(fixture.calls.length, 2)
  const [changedAddResource, changedAddEntity] = fixture.calls[1].commands
  assert.equal(changedAddResource.type, 'add-resource')
  assert.equal(changedAddEntity.type, 'add-entity')
  if (changedAddResource.type !== 'add-resource' || changedAddEntity.type !== 'add-entity') return
  assert.notEqual(fixture.calls[1].transactionId, fixture.calls[0].transactionId)
  assert.notEqual(changedAddResource.resource.id, addResource.resource.id)
  assert.notEqual(changedAddEntity.entity.id, addEntity.entity.id)
  assert.notEqual(changedAddEntity.entity.components[0]?.id, addEntity.entity.components[0]?.id)
})
