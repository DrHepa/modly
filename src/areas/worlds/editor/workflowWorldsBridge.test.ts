import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { applyWorldCommandBatch, type WorldCommand } from '../core/worldCommands.ts'
import type { WorldEditorCommandPort } from './worldEditorCommandPort.ts'
import { createWorldEditorCommandPort } from './worldEditorCommandPort.ts'
import { createWorldEditorController, type WorldEditorDispatchAuthority } from './worldEditorController.ts'
import type { LegacyWorldsCommandBridge } from './legacyWorldsCommandBridge.ts'
import type { WorldProjectCommandRequest, WorldProjectsApi } from '../../../shared/types/worldProjects.ts'
import {
  routeWorkflowOutputToWorlds,
  WorkflowWorldsOutputError,
} from '../../workflows/workflowWorldsOutput.ts'

const projectKey = `world-${'d'.repeat(32)}`

function canonicalDependencies(options: { conflict?: boolean } = {}) {
  const snapshot = createValidWorldSnapshot()
  const calls: Array<{ transactionId: string; origin: string; commands: WorldCommand[]; authority?: WorldEditorDispatchAuthority }> = []
  const commandPort = {
    getActiveContext: () => ({ projectKey, projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, activeSceneId: 'scene:one', snapshot }),
    async dispatchCommands(request: { transactionId: string; origin: string; commands: WorldCommand[] }, authority?: WorldEditorDispatchAuthority) {
      calls.push(structuredClone({ ...request, authority }))
      if (options.conflict) return { ok: false as const, error: { code: 'revision_conflict' as const, message: 'World project revision changed.', retryable: false } }
      return { ok: true as const, value: {
        transactionId: request.transactionId,
        revision: 5,
        idempotent: calls.length > 1,
        changes: [],
        warnings: [],
        receipt: { transactionId: request.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: 5 },
      } }
    },
  } as WorldEditorCommandPort
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
      getApiUrl: () => 'http://127.0.0.1:8765',
      fetchManifest: async (): Promise<Response> => { throw new Error('not configured') },
      resolvePlyKind: async () => undefined,
    },
  }
}

test('production workflow and AI bridges never import the legacy Worlds Zustand store', async () => {
  const workflowSource = await readFile(path.resolve(import.meta.dirname, '../../workflows/workflowWorldsOutput.ts'), 'utf8')
  const aiSource = await readFile(path.join(import.meta.dirname, 'worldAiCommandBridge.ts'), 'utf8')
  assert.doesNotMatch(workflowSource, /worldsSceneStore|useWorldsSceneStore|\.setScene\(/)
  assert.doesNotMatch(aiSource, /worldsSceneStore|useWorldsSceneStore|Object3D|workspaceAssetUrlResolver|window\.electron|node:fs/)
  assert.match(workflowSource, /worldEditorCommandPort/)
  assert.match(workflowSource, /legacyWorldsCommandBridge/)
})

test('canonical mesh append uses stable workflow commands and retries idempotently', async () => {
  const fixture = canonicalDependencies()
  const context = { runId: 'run:one', sourceNodeId: 'node:source', targetNodeId: 'node:worlds', artifactId: 'artifact:ship' }
  const first = await routeWorkflowOutputToWorlds('/workspace/Workflows/generated/ship.glb', 'mesh', context, fixture.dependencies)
  const retried = await routeWorkflowOutputToWorlds('/workspace/Workflows/generated/ship.glb', 'mesh', context, fixture.dependencies)
  assert.equal(first.accepted && first.mode, 'canonical')
  assert.equal(retried.accepted && retried.mode, 'canonical')
  assert.equal(retried.accepted && retried.mode === 'canonical' && retried.idempotent, true)
  assert.equal(fixture.legacyCalls.length, 0)
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.calls[0].origin, 'workflow')
  assert.deepEqual(fixture.calls[0].authority, { projectKey, projectId: 'project:demo', baseRevision: 4, activeSceneId: 'scene:one' })
  assert.equal(fixture.calls[0].transactionId, fixture.calls[1].transactionId)
  assert.deepEqual(fixture.calls[0].commands, fixture.calls[1].commands)
  assert.deepEqual(fixture.calls[0].commands.map((command) => command.type), ['add-resource', 'add-entity'])
  assert.equal(JSON.stringify(fixture.calls).includes('/workspace/'), false)
})

test('separate workflow executions at the same artifact path receive distinct transactions', async () => {
  const fixture = canonicalDependencies()
  const shared = { sourceNodeId: 'node:source', targetNodeId: 'node:worlds', artifactId: 'artifact:ship' }
  await routeWorkflowOutputToWorlds('/workspace/Workflows/generated/ship.glb', 'mesh', { ...shared, runId: 'execution:one' }, fixture.dependencies)
  await routeWorkflowOutputToWorlds('/workspace/Workflows/generated/ship.glb', 'mesh', { ...shared, runId: 'execution:two' }, fixture.dependencies)
  assert.equal(fixture.calls.length, 2)
  assert.notEqual(fixture.calls[0].transactionId, fixture.calls[1].transactionId)
  assert.notDeepEqual(fixture.calls[0].commands, fixture.calls[1].commands)
})

test('canonical legacy scene replace/append preserves editor view and navigation-only collision surfaces', async () => {
  const fixture = canonicalDependencies()
  const manifest = {
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    initialView: { position: [2, 3, 4], target: [0, 0, 0], up: [0, 1, 0] },
    collisionSurfaces: {
      schema: 'modly.collision-surfaces.v1',
      surfaces: [{
        id: 'floor', shape: 'rect', sidedness: 'double',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        geometry: { halfWidth: 2, halfHeight: 2 },
      }],
    },
    assets: [{
      id: 'ship', name: 'Ship', role: 'base-scene', workspacePath: 'Workflows/generated/ship.glb', kind: 'glb', visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  }
  fixture.dependencies.fetchManifest = async () => ({
    ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(manifest),
  } as Response)
  const replaced = await routeWorkflowOutputToWorlds('/workspace/Workflows/generated/scene.json', 'scene', { runId: 'run:scene', sceneMode: 'replace' }, fixture.dependencies)
  assert.equal(replaced.accepted && replaced.mode, 'canonical')
  const replace = fixture.calls[0].commands.find((command) => command.type === 'replace-scene')
  assert.equal(replace?.type, 'replace-scene')
  if (replace?.type === 'replace-scene') {
    assert.deepEqual(replace.scene.editor?.initialView, manifest.initialView)
    const collider = replace.scene.entities.flatMap((entity) => entity.components).find((component) => component.type === 'collider')
    assert.equal(collider?.type === 'collider' ? collider.purpose : '', 'editor-navigation')
  }
  const appended = await routeWorkflowOutputToWorlds('/workspace/Workflows/generated/scene.json', 'scene', { runId: 'run:scene', sceneMode: 'append' }, fixture.dependencies)
  assert.equal(appended.accepted && appended.mode, 'canonical')
  assert.equal(fixture.calls[1].commands.some((command) => command.type === 'add-entity'), true)
  assert.equal(fixture.calls[1].commands.some((command) => command.type === 'replace-scene'), false)
})

test('canonical workflow revision conflicts surface as structured errors without legacy fallback', async () => {
  const fixture = canonicalDependencies({ conflict: true })
  await assert.rejects(
    routeWorkflowOutputToWorlds('/workspace/Workflows/generated/conflict.glb', 'mesh', { runId: 'run:conflict' }, fixture.dependencies),
    (reason: unknown) => reason instanceof WorkflowWorldsOutputError && reason.code === 'revision_conflict' && reason.retryable === false,
  )
  assert.equal(fixture.legacyCalls.length, 0)
})

test('canonical scene preparation rejects a real concurrent edit instead of overwriting it', async () => {
  let snapshot = createValidWorldSnapshot()
  const requests: string[] = []
  const gateway = {
    async open() { return { ok: true as const, value: { status: 'ready' as const, projectKey, snapshot: structuredClone(snapshot), durabilityWarnings: [] } } },
    async applyCommands(request: WorldProjectCommandRequest) {
      requests.push(request.batch.transactionId)
      const applied = applyWorldCommandBatch(snapshot, request.batch)
      if (!applied.success) return { ok: false as const, error: { code: 'invalid_request' as const, message: 'rejected', retryable: false } }
      snapshot = structuredClone(applied.snapshot)
      return { ok: true as const, value: {
        projectKey,
        snapshot: structuredClone(applied.snapshot),
        newRevision: applied.snapshot.project.revision,
        idempotent: false,
        changes: applied.changes,
        warnings: applied.warnings,
        inverse: structuredClone(applied.inverse),
        receipt: { transactionId: request.batch.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: applied.snapshot.project.revision },
      } }
    },
  } as unknown as WorldProjectsApi
  const controller = createWorldEditorController(gateway)
  await controller.openProject(projectKey)
  const port = createWorldEditorCommandPort(controller)
  const manifest = {
    schema: 'modly.scene-manifest.v1', sceneRoot: '.',
    assets: [{ id: 'ship', name: 'Ship', role: 'base-scene', workspacePath: 'Workflows/generated/ship.glb', kind: 'glb', visible: true, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
  }
  const prepared = routeWorkflowOutputToWorlds('/workspace/Workflows/generated/scene.json', 'scene', { runId: 'execution:race' }, {
    commandPort: port,
    getApiUrl: () => 'http://127.0.0.1:8765',
    fetchManifest: async () => {
      const concurrent = await controller.dispatchCommands({
        transactionId: 'tx:concurrent-scene', origin: 'ui',
        commands: [{ type: 'set-scene-environment', sceneId: 'scene:one', environment: { backgroundColor: '#abcdef', ambientIntensity: 0.35 } }],
      })
      assert.equal(concurrent.ok, true)
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(manifest) } as Response
    },
  })
  await assert.rejects(prepared, (reason: unknown) => reason instanceof WorkflowWorldsOutputError && reason.code === 'revision_conflict')
  assert.deepEqual(requests, ['tx:concurrent-scene'])
  assert.equal(controller.getState().session?.snapshot.scenes[0].environment.backgroundColor, '#abcdef')
})

test('legacy fallback rejects when a canonical project opens during async scene or mesh preparation', async () => {
  const snapshot = createValidWorldSnapshot()
  let canonicalOpen = false
  let dispatches = 0
  const legacyCalls: string[] = []
  const commandPort = {
    getActiveContext: () => canonicalOpen ? {
      projectKey,
      projectId: snapshot.project.projectId,
      baseRevision: snapshot.project.revision,
      activeSceneId: 'scene:one',
      snapshot,
    } : null,
    async dispatchCommands() { dispatches += 1; throw new Error('unexpected canonical dispatch') },
  } as unknown as WorldEditorCommandPort
  const legacyBridge = {
    async appendRenderable() { legacyCalls.push('append'); return { accepted: true as const, mode: 'legacy' as const } },
    async replaceScene() { legacyCalls.push('replace'); return { accepted: true as const, mode: 'legacy' as const } },
  } satisfies LegacyWorldsCommandBridge
  const manifest = {
    schema: 'modly.scene-manifest.v1', sceneRoot: '.',
    assets: [{ id: 'ship', name: 'Ship', role: 'base-scene', workspacePath: 'Workflows/generated/ship.glb', kind: 'glb', visible: true, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
  }

  await assert.rejects(
    routeWorkflowOutputToWorlds('/workspace/Workflows/generated/scene.json', 'scene', { runId: 'execution:legacy-scene-race' }, {
      commandPort,
      legacyBridge,
      getApiUrl: () => 'http://127.0.0.1:8765',
      fetchManifest: async () => {
        canonicalOpen = true
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(manifest) } as Response
      },
    }),
    (reason: unknown) => reason instanceof WorkflowWorldsOutputError && reason.code === 'revision_conflict',
  )

  canonicalOpen = false
  await assert.rejects(
    routeWorkflowOutputToWorlds('/workspace/Workflows/generated/ship.glb', 'mesh', { runId: 'execution:legacy-mesh-race' }, {
      commandPort,
      legacyBridge,
      getApiUrl: () => 'http://127.0.0.1:8765',
      resolvePlyKind: async () => {
        canonicalOpen = true
        return undefined
      },
    }),
    (reason: unknown) => reason instanceof WorkflowWorldsOutputError && reason.code === 'revision_conflict',
  )
  assert.deepEqual(legacyCalls, [])
  assert.equal(dispatches, 0)
})
