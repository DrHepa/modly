import assert from 'node:assert/strict'
import test from 'node:test'

import { createEditPlan } from './sceneEdit.ts'
import {
  buildSceneEditExportPlan,
  buildSceneEditOutputPaths,
  buildSceneEditSidecarMetadata,
} from './sceneEditExport.ts'
import type { ScenePart } from './sceneEdit.types.ts'

const createdAt = '2026-05-17T15:00:00.000Z'

test('buildSceneEditExportPlan creates clone exclusion intent with IDs only for allowed excluded parts', () => {
  const wheel = scenePart('mesh:Root#0/mesh:Wheel#0', 'Wheel')
  const door = scenePart('mesh:Root#0/mesh:Door#0', 'Door')
  const plan = createEditPlan({
    sourceArtifactId: 'artifact:vehicle 1',
    sourceVersionId: 'version-1',
    sourceWorkspacePath: 'Workflows/checkpoints/vehicle.glb',
    excludedPartIds: [wheel.id],
  })

  const result = buildSceneEditExportPlan({ editPlan: plan, parts: [wheel, door], createdAt })

  assert.equal(result.success, true)
  assert.deepEqual(result.plan.cloneIntent, {
    operation: 'clone-scene-and-remove-excluded-parts',
    excludedPartIds: [wheel.id],
    materialHandling: 'restore-original-materials-before-export',
    exporter: 'GLTFExporter',
  })
  assert.deepEqual(result.plan.excludedParts, [{ id: wheel.id, label: 'Wheel' }])
  assert.equal(result.plan.cloneIntent.excludedPartIds.includes(door.id), false)
})

test('buildSceneEditExportPlan rejects empty, unknown, and blocked exclusion plans', () => {
  const wheel = scenePart('mesh:Root#0/mesh:Wheel#0', 'Wheel')
  const blocked = scenePart('skinned-mesh:Root#0/skinned-mesh:Body#0', 'Body', {
    selectable: false,
    guardrail: { status: 'blocked', reason: 'skinned-mesh', message: 'Skinned meshes cannot be safely excluded.' },
  })

  const empty = buildSceneEditExportPlan({
    editPlan: createEditPlan({ sourceArtifactId: 'artifact-1', sourceWorkspacePath: 'Workflows/checkpoints/source.glb' }),
    parts: [wheel],
    createdAt,
  })
  const unknown = buildSceneEditExportPlan({
    editPlan: createEditPlan({
      sourceArtifactId: 'artifact-1',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      excludedPartIds: ['mesh:Missing#0'],
    }),
    parts: [wheel],
    createdAt,
  })
  const blockedResult = buildSceneEditExportPlan({
    editPlan: createEditPlan({
      sourceArtifactId: 'artifact-1',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      excludedPartIds: [blocked.id],
    }),
    parts: [blocked],
    createdAt,
  })

  assert.deepEqual(empty, { success: false, reason: 'empty-exclusion-plan', message: 'At least one excluded part is required to export an edited copy.' })
  assert.deepEqual(unknown, { success: false, reason: 'unknown-part', partIds: ['mesh:Missing#0'], message: 'Excluded parts must exist in the collected scene parts.' })
  assert.deepEqual(blockedResult, { success: false, reason: 'blocked-part', partIds: [blocked.id], message: 'Blocked guardrail parts cannot be excluded from an edited export.' })
})

test('buildSceneEditOutputPaths creates deterministic workspace-relative GLB and sidecar paths without source overwrite', () => {
  const result = buildSceneEditOutputPaths({
    sourceWorkspacePath: 'Workflows/checkpoints/My Vehicle.glb',
    sourceArtifactId: 'artifact:vehicle 1',
    createdAt,
  })

  assert.deepEqual(result, {
    success: true,
    glbWorkspacePath: 'Workflows/edited/My_Vehicle-edited-artifact_vehicle_1-20260517T150000000Z.glb',
    sidecarWorkspacePath: 'Workflows/edited/My_Vehicle-edited-artifact_vehicle_1-20260517T150000000Z.json',
  })
})

test('buildSceneEditOutputPaths rejects unsafe output paths and source overwrites at planning layer', () => {
  const absolute = buildSceneEditOutputPaths({
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    sourceArtifactId: 'artifact-1',
    createdAt,
    requestedOutputWorkspacePath: '/tmp/source-edited.glb',
  })
  const traversal = buildSceneEditOutputPaths({
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    sourceArtifactId: 'artifact-1',
    createdAt,
    requestedOutputWorkspacePath: 'Workflows/edited/../source-edited.glb',
  })
  const overwrite = buildSceneEditOutputPaths({
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    sourceArtifactId: 'artifact-1',
    createdAt,
    requestedOutputWorkspacePath: 'Workflows/checkpoints/source.glb',
  })

  assert.deepEqual(absolute, { success: false, reason: 'unsafe-output-path', message: 'Edited export path must be workspace-relative under Workflows/edited/.' })
  assert.deepEqual(traversal, { success: false, reason: 'unsafe-output-path', message: 'Edited export path must be workspace-relative under Workflows/edited/.' })
  assert.deepEqual(overwrite, { success: false, reason: 'source-overwrite', message: 'Edited export path must not overwrite the source artifact.' })
})

test('buildSceneEditSidecarMetadata records source, excluded labels, exporter, lineage intent, and non-destructive copy', () => {
  const wheel = scenePart('mesh:Root#0/mesh:Wheel#0', 'Wheel')
  const plan = createEditPlan({
    sourceArtifactId: 'artifact-1',
    sourceVersionId: 'version-1',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    excludedPartIds: [wheel.id],
  })

  const metadata = buildSceneEditSidecarMetadata({ editPlan: plan, excludedParts: [wheel], createdAt })

  assert.deepEqual(metadata, {
    kind: 'scene-edit',
    source: { artifactId: 'artifact-1', versionId: 'version-1', workspacePath: 'Workflows/checkpoints/source.glb' },
    excludedParts: [{ id: wheel.id, label: 'Wheel' }],
    exporter: { intended: 'GLTFExporter', binary: true },
    createdAt,
    lineageIntent: { type: 'wait-replacement', sourceArtifactId: 'artifact-1', sourceVersionId: 'version-1' },
    actionCopy: { hideLabel: 'Hide from edited copy', exportLabel: 'Exclude from export', destructive: false },
    cloneIntent: {
      operation: 'clone-scene-and-remove-excluded-parts',
      excludedPartIds: [wheel.id],
      materialHandling: 'restore-original-materials-before-export',
      exporter: 'GLTFExporter',
    },
  })
})

function scenePart(id: string, label: string, overrides: Partial<ScenePart> = {}): ScenePart {
  return {
    id,
    label,
    type: 'mesh',
    path: ['Root', label],
    siblingIndex: 0,
    selectable: true,
    guardrail: { status: 'allowed' },
    ...overrides,
  }
}
