import assert from 'node:assert/strict'
import test from 'node:test'
import { Mesh, Object3D, BoxGeometry, MeshBasicMaterial, type Object3D as ThreeObject3D } from 'three'

import { createEditPlan, collectSceneParts } from './sceneEdit.ts'
import {
  exportEditedSceneArtifact,
  saveEditedScenePendingReplacement,
  resolveScenePartIdForObject,
  resolveSceneEditSourceDescriptor,
  resolveSceneEditControlsVisibility,
} from './sceneEditExportRuntime.ts'
import type { ArtifactRef } from '../../shared/types/artifacts.ts'

function makeScene(): Object3D {
  const scene = new Object3D()
  scene.name = 'Scene'
  const keep = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 'green' }))
  keep.name = 'Keep mesh'
  const remove = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 'red' }))
  remove.name = 'Remove mesh'
  scene.add(keep, remove)
  return scene
}

test('resolveSceneEditControlsVisibility only exposes edit controls for eligible checkpoint mesh previews', () => {
  assert.deepEqual(
    resolveSceneEditControlsVisibility({
      modelSource: {
        kind: 'workflow-checkpoint',
        modelUrl: '/workspace/Workflows/checkpoints/wait.glb',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      },
      source: { type: 'mesh', workspacePath: 'Workflows/checkpoints/wait.glb' },
    }),
    { visible: true },
  )

  assert.deepEqual(
    resolveSceneEditControlsVisibility({
      modelSource: { kind: 'final', modelUrl: '/workspace/final/model.glb', isCheckpointPreview: false, label: 'Final output' },
      source: { type: 'mesh', workspacePath: 'final/model.glb' },
    }),
    { visible: false, reason: 'not-checkpoint-preview' },
  )

  assert.deepEqual(
    resolveSceneEditControlsVisibility({
      modelSource: {
        kind: 'workflow-checkpoint',
        modelUrl: '/workspace/Workflows/checkpoints/preview.png',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      },
      source: { type: 'image', workspacePath: 'Workflows/checkpoints/preview.png' },
    }),
    { visible: false, reason: 'not-mesh-artifact' },
  )
})

test('resolveSceneEditSourceDescriptor derives safe workspace mesh source from checkpoint URL and rejects final output', () => {
  assert.deepEqual(
    resolveSceneEditSourceDescriptor({
      currentJobId: 'job-1',
      modelSource: {
        kind: 'workflow-checkpoint',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/checkpoints/wait.glb',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      },
    }),
    {
      artifactId: 'job-1',
      artifact: { type: 'mesh', workspacePath: 'Workflows/checkpoints/wait.glb' },
    },
  )

  assert.equal(
    resolveSceneEditSourceDescriptor({
      currentJobId: 'job-1',
      modelSource: { kind: 'final', modelUrl: '/workspace/final/model.glb', isCheckpointPreview: false, label: 'Final output' },
    }),
    null,
  )
})

test('resolveScenePartIdForObject selects the clicked mesh by stable scene part ID and rejects blocked rig parts', () => {
  const scene = makeScene()
  const target = scene.children.find((child) => child.name === 'Remove mesh')
  assert.ok(target)
  const parts = collectSceneParts(scene)
  const expected = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(expected)

  assert.equal(resolveScenePartIdForObject({ scene, target, parts }), expected.id)

  const blocked = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial())
  blocked.name = 'Rigged'
  scene.add(blocked)
  const blockedParts = collectSceneParts(scene, { animatedNodeNames: ['Rigged'] })
  assert.equal(resolveScenePartIdForObject({ scene, target: blocked, parts: blockedParts }), null)
})

test('exportEditedSceneArtifact clones the scene, removes excluded clone parts, writes GLB bytes and leaves original untouched', async () => {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const removePart = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(removePart)
  const plan = createEditPlan({
    sourceArtifactId: 'artifact-1',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    excludedPartIds: [removePart.id],
  })
  const exportedByteLength = 4
  let parsedScene: ThreeObject3D | null = null
  const writtenRequests: unknown[] = []

  const result = await exportEditedSceneArtifact({
    scene,
    parts,
    editPlan: plan,
    createdAt: '2026-05-17T15:00:00.000Z',
    exporter: {
      parse(input, onDone) {
        parsedScene = input
        onDone(new Uint8Array([1, 2, 3, 4]).buffer)
      },
    },
    writer: async (request) => {
      writtenRequests.push(request)
      return {
        success: true,
        glbWorkspacePath: request.glbWorkspacePath,
        sidecarWorkspacePath: request.sidecarWorkspacePath,
        metadata: request.metadata,
      }
    },
  })

  assert.equal(result.success, true)
  assert.equal(writtenRequests.length, 1)
  assert.equal((writtenRequests[0] as { bytes: Uint8Array }).bytes.byteLength, exportedByteLength)
  const exportedScene = parsedScene as ThreeObject3D | null
  assert.ok(exportedScene)
  assert.notEqual(exportedScene, scene)
  assert.equal(scene.children.some((child) => child.name === 'Remove mesh'), true)
  assert.equal(exportedScene.children.some((child) => child.name === 'Remove mesh'), false)
  assert.equal(exportedScene.children.some((child) => child.name === 'Keep mesh'), true)
})

test('exportEditedSceneArtifact reports exporter failures and never calls the writer or mutates source scene', async () => {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const removePart = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(removePart)
  const plan = createEditPlan({
    sourceArtifactId: 'artifact-1',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    excludedPartIds: [removePart.id],
  })
  let writerCalls = 0

  const result = await exportEditedSceneArtifact({
    scene,
    parts,
    editPlan: plan,
    createdAt: '2026-05-17T15:00:00.000Z',
    exporter: {
      parse(_input, _onDone, onError) {
        onError?.(new Error('export failed'))
      },
    },
    writer: async () => {
      writerCalls += 1
      throw new Error('writer must not be called')
    },
  })

  assert.deepEqual(result, { success: false, error: 'export failed' })
  assert.equal(writerCalls, 0)
  assert.equal(scene.children.some((child) => child.name === 'Remove mesh'), true)
})

test('exportEditedSceneArtifact rejects non-binary GLTFExporter output before IPC writer', async () => {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const removePart = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(removePart)
  const plan = createEditPlan({
    sourceArtifactId: 'artifact-1',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    excludedPartIds: [removePart.id],
  })
  let writerCalls = 0

  const result = await exportEditedSceneArtifact({
    scene,
    parts,
    editPlan: plan,
    createdAt: '2026-05-17T15:00:00.000Z',
    exporter: {
      parse(_input, onDone) {
        onDone({ asset: { version: '2.0' } })
      },
    },
    writer: async () => {
      writerCalls += 1
      throw new Error('writer must not be called')
    },
  })

  assert.deepEqual(result, { success: false, error: 'GLTFExporter returned non-binary output.' })
  assert.equal(writerCalls, 0)
})

test('saveEditedScenePendingReplacement registers the edited mesh with lineage and sets pending replacement after writer success', async () => {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const removePart = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(removePart)
  const sourceArtifact: ArtifactRef = {
    id: 'checkpoint-mesh',
    kind: 'mesh',
    uri: 'Workflows/checkpoints/source.glb',
    versionId: 'checkpoint-mesh-original',
    legacy: { filePath: 'Workflows/checkpoints/source.glb', outputType: 'mesh' },
  }
  const pendingReplacements: ArtifactRef[] = []

  const result = await saveEditedScenePendingReplacement({
    scene,
    parts,
    editPlan: createEditPlan({
      sourceArtifactId: sourceArtifact.id,
      sourceVersionId: sourceArtifact.versionId,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      excludedPartIds: [removePart.id],
    }),
    createdAt: '2026-05-17T15:30:00.000Z',
    sourceArtifact,
    setPendingReplacement: (artifact) => pendingReplacements.push(artifact),
    exporter: {
      parse(_input, onDone) {
        onDone(new Uint8Array([1, 2, 3, 4]).buffer)
      },
    },
    writer: async (request) => ({
      success: true,
      glbWorkspacePath: request.glbWorkspacePath,
      sidecarWorkspacePath: request.sidecarWorkspacePath,
      metadata: request.metadata,
    }),
  })

  assert.equal(result.success, true)
  assert.equal(pendingReplacements.length, 1)
  assert.deepEqual(pendingReplacements[0], result.success ? result.artifact : undefined)
  assert.equal(result.success ? result.artifact.kind : undefined, 'mesh')
  assert.equal(result.success ? result.artifact.uri : undefined, 'Workflows/edited/source-edited-checkpoint-mesh-20260517T153000000Z.glb')
  assert.equal(result.success ? result.artifact.legacy?.filePath : undefined, 'Workflows/edited/source-edited-checkpoint-mesh-20260517T153000000Z.glb')
  assert.equal(result.success ? result.lineageIntent.sourceArtifactId : undefined, 'checkpoint-mesh')
  assert.equal(result.success ? result.lineageIntent.sourceVersionId : undefined, 'checkpoint-mesh-original')
  assert.equal(result.success ? result.lineageIntent.sidecarWorkspacePath : undefined, 'Workflows/edited/source-edited-checkpoint-mesh-20260517T153000000Z.json')
})

test('saveEditedScenePendingReplacement does not set pending replacement when writer or registration fails', async () => {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const removePart = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(removePart)
  const sourceArtifact: ArtifactRef = {
    id: 'checkpoint-mesh',
    kind: 'mesh',
    uri: 'Workflows/checkpoints/source.glb',
    versionId: 'checkpoint-mesh-original',
    legacy: { filePath: 'Workflows/checkpoints/source.glb', outputType: 'mesh' },
  }
  const editPlan = createEditPlan({
    sourceArtifactId: sourceArtifact.id,
    sourceVersionId: sourceArtifact.versionId,
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    excludedPartIds: [removePart.id],
  })
  const exporter = {
    parse(_input: ThreeObject3D, onDone: (result: ArrayBuffer | object) => void) {
      onDone(new Uint8Array([1, 2, 3, 4]).buffer)
    },
  }
  const pendingReplacements: ArtifactRef[] = []

  const writerFailure = await saveEditedScenePendingReplacement({
    scene,
    parts,
    editPlan,
    createdAt: '2026-05-17T15:30:00.000Z',
    sourceArtifact,
    setPendingReplacement: (artifact) => pendingReplacements.push(artifact),
    exporter,
    writer: async () => ({ success: false, error: 'writer failed' }),
  })
  const registrationFailure = await saveEditedScenePendingReplacement({
    scene,
    parts,
    editPlan,
    createdAt: '2026-05-17T15:30:00.000Z',
    sourceArtifact,
    setPendingReplacement: (artifact) => pendingReplacements.push(artifact),
    exporter,
    writer: async (request) => ({
      success: true,
      glbWorkspacePath: request.glbWorkspacePath,
      sidecarWorkspacePath: request.sidecarWorkspacePath,
      metadata: request.metadata,
    }),
    registerEditedArtifact: () => ({ success: false, error: 'registration failed' }),
  })

  assert.deepEqual(writerFailure, { success: false, stage: 'write', error: 'writer failed' })
  assert.deepEqual(registrationFailure, { success: false, stage: 'registration', error: 'registration failed' })
  assert.equal(pendingReplacements.length, 0)
  assert.equal(scene.children.some((child) => child.name === 'Remove mesh'), true)
})

test('saveEditedScenePendingReplacement does not write or set pending replacement when exporter fails', async () => {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const removePart = parts.find((part) => part.label === 'Remove mesh')
  assert.ok(removePart)
  const sourceArtifact: ArtifactRef = {
    id: 'checkpoint-mesh',
    kind: 'mesh',
    uri: 'Workflows/checkpoints/source.glb',
    versionId: 'checkpoint-mesh-original',
    legacy: { filePath: 'Workflows/checkpoints/source.glb', outputType: 'mesh' },
  }
  const pendingReplacements: ArtifactRef[] = []
  let writerCalls = 0

  const result = await saveEditedScenePendingReplacement({
    scene,
    parts,
    editPlan: createEditPlan({
      sourceArtifactId: sourceArtifact.id,
      sourceVersionId: sourceArtifact.versionId,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      excludedPartIds: [removePart.id],
    }),
    createdAt: '2026-05-17T15:30:00.000Z',
    sourceArtifact,
    setPendingReplacement: (artifact) => pendingReplacements.push(artifact),
    exporter: {
      parse(_input, _onDone, onError) {
        onError?.(new Error('export failed'))
      },
    },
    writer: async () => {
      writerCalls += 1
      throw new Error('writer must not be called')
    },
  })

  assert.deepEqual(result, { success: false, stage: 'export', error: 'export failed' })
  assert.equal(writerCalls, 0)
  assert.equal(pendingReplacements.length, 0)
  assert.equal(scene.children.some((child) => child.name === 'Remove mesh'), true)
})
