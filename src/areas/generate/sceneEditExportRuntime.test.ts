import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import type { Workflow } from '../../shared/types/electron.d.ts'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { AnimationMixer, Scene, Matrix4, Quaternion, Vector3, AnimationClip, Bone, Skeleton, SkinnedMesh, Float32BufferAttribute, Uint16BufferAttribute, VectorKeyframeTrack, Texture, Material, Mesh, Object3D, BoxGeometry, MeshBasicMaterial, type Object3D as ThreeObject3D } from 'three'

import { createEditPlan, collectSceneParts } from './sceneEdit.ts'
import {
  exportEditedSceneArtifact,
  saveEditedScenePendingReplacement,
  resolveScenePartIdForObject,
  resolveSceneEditSourceDescriptor,
  resolveSceneEditControlsVisibility,
} from './sceneEditExportRuntime.ts'
import type { CheckpointOwner } from '../workflows/workflowArtifacts.ts'
import type { SaveEditedScenePendingReplacementInput } from './sceneEditExportRuntime.ts'
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
    checkpointNodeId: 'wait',
    getCheckpointOwner: () => checkpointOwner(),
    setPendingReplacement: (_owner, artifact) => { pendingReplacements.push(artifact); return true },
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
    checkpointNodeId: 'wait',
    getCheckpointOwner: () => checkpointOwner(),
    setPendingReplacement: (_owner, artifact) => { pendingReplacements.push(artifact); return true },
    exporter,
    writer: async () => ({ success: false, error: 'writer failed' }),
  })
  const registrationFailure = await saveEditedScenePendingReplacement({
    scene,
    parts,
    editPlan,
    createdAt: '2026-05-17T15:30:00.000Z',
    sourceArtifact,
    checkpointNodeId: 'wait',
    getCheckpointOwner: () => checkpointOwner(),
    setPendingReplacement: (_owner, artifact) => { pendingReplacements.push(artifact); return true },
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
    checkpointNodeId: 'wait',
    getCheckpointOwner: () => checkpointOwner(),
    setPendingReplacement: (_owner, artifact) => { pendingReplacements.push(artifact); return true },
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


function checkpointOwner(): CheckpointOwner {
  return { runId: 'run-1', nodeId: 'wait', inputArtifactId: 'checkpoint-mesh', inputVersionId: 'checkpoint-mesh-original', revision: 0 }
}

function exportFixture(): SaveEditedScenePendingReplacementInput {
  const scene = makeScene()
  const parts = collectSceneParts(scene)
  const owner = checkpointOwner()
  const sourceArtifact: ArtifactRef = { id: owner.inputArtifactId, versionId: owner.inputVersionId, kind: 'mesh', uri: 'Workflows/checkpoints/source.glb' }
  return { scene, parts, sourceArtifact, checkpointNodeId: 'wait', getCheckpointOwner: () => owner,
    setPendingReplacement: () => true,
    editPlan: createEditPlan({ sourceArtifactId: sourceArtifact.id, sourceVersionId: sourceArtifact.versionId, sourceWorkspacePath: sourceArtifact.uri!, excludedPartIds: [parts[1].id] }),
    createdAt: '2026-05-17T15:30:00.000Z',
    exporter: { parse(_scene, done) { done(new Uint8Array([1, 2, 3, 4]).buffer) } },
    writer: async request => ({ success: true, glbWorkspacePath: request.glbWorkspacePath, sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata }) }
}

for (const invalidation of ['cancel', 'reset', 'clear', 'publish', 'continue', 'new-run']) {
  test(`deferred export stays saved-unselected after ${invalidation} and never refreshes owner`, async () => {
    const input = exportFixture()
    let owner: CheckpointOwner | undefined = checkpointOwner()
    let getCalls = 0; let setCalls = 0
    input.getCheckpointOwner = () => { getCalls++; return owner }
    input.setPendingReplacement = (captured) => { setCalls++; assert.equal(captured.runId, 'run-1'); assert.equal(captured.revision, 0); return false }
    let done!: (buffer: ArrayBuffer) => void
    input.exporter = { parse(_scene, onDone) { done = onDone } }
    const saving = saveEditedScenePendingReplacement(input)
    assert.equal(getCalls, 1)
    owner = invalidation === 'clear' || invalidation === 'publish' ? { ...owner!, revision: 1 } : undefined
    input.sourceArtifact.versionId = 'mutated-after-start'
    done(new Uint8Array([1, 2]).buffer)
    const result = await saving
    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.status, 'saved-unselected')
      assert.equal(result.lineageIntent.sourceVersionId, 'checkpoint-mesh-original')
    }
    assert.equal(getCalls, 1); assert.equal(setCalls, 1)
  })
}

for (const failure of ['writer-reject', 'exporter-reject', 'exporter-throw', 'registration-throw']) {
  test(`rejected async boundary ${failure} is a staged failure without publication`, async () => {
    const input = exportFixture()
    let calls = 0; input.setPendingReplacement = () => { calls++; return true }
    if (failure === 'writer-reject') input.writer = async () => { throw new Error(failure) }
    if (failure === 'exporter-reject') input.exporter = { parse: async () => { throw new Error(failure) } }
    if (failure === 'exporter-throw') input.exporter = { parse: () => { throw new Error(failure) } }
    if (failure === 'registration-throw') input.registerEditedArtifact = () => { throw new Error(failure) }
    const result = await saveEditedScenePendingReplacement(input)
    assert.equal(result.success, false)
    assert.equal(calls, 0)
    if (!result.success) assert.equal(result.error, failure)
  })
}

test('wrong checkpoint source, version or missing owner never starts exporter', async () => {
  for (const change of ['missing', 'source', 'version', 'path']) {
    const input = exportFixture()
    if (change === 'missing') input.getCheckpointOwner = () => undefined
    if (change === 'source') input.editPlan.sourceArtifactId = 'other-source'
    if (change === 'version') input.editPlan.sourceVersionId = 'other-version'
    if (change === 'path') input.editPlan.sourceWorkspacePath = 'Workflows/other.glb'
    let calls = 0; input.exporter = { parse() { calls++ } }
    const result = await saveEditedScenePendingReplacement(input)
    assert.equal(result.success, false, change); assert.equal(calls, 0, change)
  }
})

test('runtime rechecks real descendant dependencies even with forged allowed parts', async () => {
  const input = exportFixture()
  const bone = new Bone(); input.scene.children[1].add(bone)
  let calls = 0; input.exporter = { parse() { calls++ } }
  const result = await exportEditedSceneArtifact(input)
  assert.equal(result.success, false); assert.equal(calls, 0)
})

test('source descriptors reject malformed encoded URLs without throwing or leaking absolute paths', () => {
  for (const modelUrl of ['/workspace/%zz.glb', '/workspace/C:%5cprivate%5csource.glb', '/workspace/../private.glb', '/workspace/%2fprivate.glb', 'blob:local/workspace/source.glb']) {
    assert.equal(resolveSceneEditSourceDescriptor({ currentJobId: 'job', modelSource: { kind: 'workflow-checkpoint', modelUrl, isCheckpointPreview: true, label: 'Temporary checkpoint — not final output' } }), null)
  }
})


function rigFixture() {
  const scene = new Object3D(); scene.name = 'RootFixture'; scene.position.set(3, -2, 5); scene.scale.set(1.5, 2, 0.75)
  const nested = new Object3D(); nested.name = 'CharacterGroup'; nested.position.set(2, 1, -1); nested.scale.set(0.5, 0.75, 1.25)
  const joint = new Bone(); joint.name = 'Joint'; joint.position.y = 0.5
  const tip = new Bone(); tip.name = 'Tip'; tip.position.y = 1; joint.add(tip)
  const geometry = new BoxGeometry(1, 1, 1)
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: count }, () => [0, 1, 0, 0]).flat(), 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [0.75, 0.25, 0, 0]).flat(), 4))
  for (const group of geometry.groups) group.materialIndex = group.materialIndex! % 2
  const first = new MeshBasicMaterial({ color: 0x224488 }); first.name = 'OriginalBlue'
  const second = new MeshBasicMaterial({ color: 0x884422 }); second.name = 'OriginalRed'
  const skin: SkinnedMesh = new SkinnedMesh(geometry, [first, second]); skin.name = 'Skin'; skin.position.set(0.25, 0.5, -0.25)
  nested.add(joint, skin); scene.add(nested)
  const sharedGeometry = new BoxGeometry(0.5, 0.75, 1)
  const staticA = new Mesh(sharedGeometry, first); staticA.name = 'StaticA'; staticA.visible = false
  const staticB = new Mesh(sharedGeometry, first); staticB.name = 'StaticB'; staticB.position.x = 2
  const remove = new Mesh(sharedGeometry, second); remove.name = 'Remove'
  scene.add(staticA, staticB, remove)
  scene.updateMatrixWorld(true)
  skin.bind(new Skeleton([joint, tip]))
  const clip = new AnimationClip('JointMotion', 1, [new VectorKeyframeTrack(`${tip.uuid}.position`, [0, 1], [0, 1, 0, 0, 1.5, 0])])
  const parts = collectSceneParts(scene, { animationClips: [clip] })
  return { scene, nested, skin, joint, tip, staticA, staticB, remove, clip, first, second, parts,
    editPlan: createEditPlan({ sourceArtifactId: 'rig', sourceVersionId: 'rig-v1', sourceWorkspacePath: 'Workflows/rig.glb', excludedPartIds: [parts.find(part => part.label === 'Remove')!.id] }) }
}

function sceneFingerprint(scene: Object3D): string {
  const values: unknown[] = []
  scene.traverse(node => values.push({
    uuid: node.uuid, name: node.name, parent: node.parent?.uuid, children: node.children.map(child => child.uuid),
    position: node.position.toArray(), quaternion: node.quaternion.toArray(), scale: node.scale.toArray(),
    matrix: node.matrix.toArray(), matrixWorld: node.matrixWorld.toArray(), matrixWorldNeedsUpdate: node.matrixWorldNeedsUpdate,
    visible: node.visible,
    ...(node instanceof Mesh ? {
      geometry: node.geometry.toJSON(),
      materials: (Array.isArray(node.material) ? node.material : [node.material]).map(material => material.toJSON()),
    } : {}),
    ...(node instanceof SkinnedMesh ? { skeleton: node.skeleton.toJSON(), bindMatrix: node.bindMatrix.toArray(), bindMatrixInverse: node.bindMatrixInverse.toArray() } : {}),
  }))
  return JSON.stringify(values)
}

for (const fail of [false, true]) {
  test(`skeleton-aware export owns clone resources and authoritative materials without poisoning source (${fail ? 'failure' : 'success'})`, async () => {
    const fixture = rigFixture()
    const texture = new Texture(); fixture.first.map = texture
    const original = fixture.skin.material
    fixture.skin.userData.originalMaterial = { not: 'a material' }
    const overlay = new MeshBasicMaterial({ color: 0xffff00 }); fixture.skin.material = overlay
    const sourceFingerprint = sceneFingerprint(fixture.scene)
    const sourceVersion = texture.source.version
    let sourceDisposals = 0; let ownedDisposals = 0
    for (const resource of [fixture.skin.geometry, fixture.staticA.geometry, fixture.first, fixture.second, overlay, texture]) resource.addEventListener('dispose', () => { sourceDisposals++ })
    const result = await exportEditedSceneArtifact({ ...fixture, animationClips: [fixture.clip], originalMaterials: new Map([[fixture.skin, original]]), createdAt: '2026-10-06T12:00:00Z',
      exporter: { parse(clone, done, error, options) {
        const skin = clone.getObjectByName('Skin') as SkinnedMesh
        const staticA = clone.getObjectByName('StaticA') as Mesh
        const staticB = clone.getObjectByName('StaticB') as Mesh
        assert.notEqual(skin.skeleton, fixture.skin.skeleton)
        assert.notEqual(skin.geometry, fixture.skin.geometry)
        assert.notEqual(skin.geometry.getAttribute('position').array, fixture.skin.geometry.getAttribute('position').array)
        assert.equal(staticA.geometry, staticB.geometry)
        assert.notEqual(staticA.geometry, fixture.staticA.geometry)
        assert.ok(skin.skeleton.bones.every(bone => bone !== fixture.joint && bone !== fixture.tip))
        assert.equal(skin.skeleton.bones[0], clone.getObjectByName('Joint'))
        assert.equal(skin.skeleton.bones[1], clone.getObjectByName('Tip'))
        assert.notEqual(skin.skeleton.boneInverses[0], fixture.skin.skeleton.boneInverses[0])
        assert.ok(Array.isArray(skin.material)); assert.equal(skin.material.length, 2)
        const material = skin.material[0] as MeshBasicMaterial
        assert.ok(material instanceof Material); assert.notEqual(material, fixture.first); assert.equal(material.color.getHex(), fixture.first.color.getHex())
        assert.notEqual(material.map, texture); assert.notEqual(material.map?.source, texture.source)
        assert.equal(skin.userData.originalMaterial, undefined)
        assert.equal(options?.animations.length, 1)
        assert.notEqual(options?.animations[0], fixture.clip)
        assert.equal(options?.animations[0].tracks[0].name, `${skin.skeleton.bones[1].uuid}.position`)
        assert.equal(options?.onlyVisible, false)
        const resources = new Set([skin.geometry, staticA.geometry, ...skin.material, material.map!])
        for (const resource of resources) resource.addEventListener('dispose', () => { ownedDisposals++ })
        // Prove ownership with writes to the clone's mutable state before success/failure.
        skin.skeleton.bones[0].position.y = 99; skin.skeleton.boneInverses[0].elements[0] = 42
        skin.geometry.getAttribute('position').setX(0, 99); material.color.set(0)
        material.map!.offset.x = 42
        if (fail) error?.(new Error('synthetic exporter failure')); else done(new Uint8Array([1]).buffer)
      } },
      writer: async request => ({ success: true, glbWorkspacePath: request.glbWorkspacePath, sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata }),
    })
    assert.equal(result.success, !fail)
    assert.equal(sceneFingerprint(fixture.scene), sourceFingerprint)
    assert.equal(texture.source.version, sourceVersion)
    assert.equal(fixture.skin.material, overlay)
    assert.equal(sourceDisposals, 0); assert.equal(ownedDisposals, 5)
  })
}

test('real CPU GLTFExporter to GLTFLoader roundtrip preserves nested skin, clips, original materials and transforms', async () => {
  // GLTFExporter uses browser FileReader for in-memory Blob buffers, not DOM/GPU.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
  class MemoryFileReader {
    result: ArrayBuffer | string | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(buffer => { this.result = buffer; this.onloadend?.() }) }
    readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onloadend?.() }) }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: MemoryFileReader })
  try {
    const fixture = rigFixture()
    const fingerprint = sceneFingerprint(fixture.scene)
    const clipJson = JSON.stringify(AnimationClip.toJSON(fixture.clip))
    let bytes: Uint8Array | undefined
    const result = await exportEditedSceneArtifact({ ...fixture, animationClips: [fixture.clip], createdAt: '2026-10-06T12:00:00Z', exporter: new GLTFExporter(),
      writer: async request => { bytes = request.bytes instanceof Uint8Array ? request.bytes : new Uint8Array(request.bytes); return { success: true, glbWorkspacePath: request.glbWorkspacePath, sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata } },
    })
    assert.equal(result.success, true, JSON.stringify(result)); assert.ok(bytes)
    const buffer = Uint8Array.from(bytes).buffer
    assert.equal(new DataView(buffer).getUint32(0, true), 0x46546c67)
    const loaded = await new GLTFLoader().parseAsync(buffer, '')
    const skins: SkinnedMesh[] = []
    loaded.scene.traverse(node => { if (node instanceof SkinnedMesh) skins.push(node) })
    // Multi-material glTF primitives may reload as separate skinned meshes.
    assert.equal(skins.length, fixture.skin.geometry.groups.length)
    for (const skin of skins) {
      assert.equal(skin.skeleton.bones.length, 2)
      assert.deepEqual(skin.skeleton.bones.map(bone => bone.name), ['Joint', 'Tip'])
      assert.ok(skin.skeleton.bones.every(bone => loaded.scene.getObjectById(bone.id) === bone))
      assert.equal(skin.geometry.getAttribute('skinWeight').getX(0), 0.75)
    }
    assert.equal(loaded.scene.getObjectByName('Remove'), undefined)
    assert.ok(loaded.scene.getObjectByName('StaticA')); assert.ok(loaded.scene.getObjectByName('StaticB'))
    assert.deepEqual(loaded.scene.getObjectByName('RootFixture')?.position.toArray(), fixture.scene.position.toArray())
    assert.deepEqual(loaded.scene.getObjectByName('RootFixture')?.scale.toArray(), fixture.scene.scale.toArray())
    assert.deepEqual(loaded.scene.getObjectByName('CharacterGroup')?.position.toArray(), fixture.nested.position.toArray())
    assert.deepEqual(loaded.scene.getObjectByName('CharacterGroup')?.scale.toArray(), fixture.nested.scale.toArray())
    assert.equal(loaded.animations.length, 1); assert.equal(loaded.animations[0].name, 'JointMotion')
    assert.equal(loaded.animations[0].tracks[0].name, 'Tip.position')
    assert.deepEqual(Array.from(loaded.animations[0].tracks[0].values), [0, 1, 0, 0, 1.5, 0])
    const materialNames = skins.map(skin => (skin.material as Material).name).sort()
    assert.deepEqual([...new Set(materialNames)], ['OriginalBlue', 'OriginalRed'])
    assert.equal(sceneFingerprint(fixture.scene), fingerprint)
    assert.equal(JSON.stringify(AnimationClip.toJSON(fixture.clip)), clipJson)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'FileReader', previous)
    else Reflect.deleteProperty(globalThis, 'FileReader')
  }
})

test('external skeleton bones and unsupported animation tracks fail without writing or mutating sources', async () => {
  for (const invalid of ['external-bone', 'unsupported-track']) {
    const fixture = rigFixture()
    if (invalid === 'external-bone') fixture.tip.removeFromParent()
    else fixture.clip.tracks[0].name = `${fixture.tip.uuid}.rotation`
    const fingerprint = sceneFingerprint(fixture.scene)
    let calls = 0
    const result = await exportEditedSceneArtifact({ ...fixture, animationClips: [fixture.clip], createdAt: '2026-10-06T12:00:00Z',
      exporter: { parse(_clone, done) { calls++; done(new Uint8Array([1]).buffer) } }, writer: async () => { calls++; throw new Error('not reached') } })
    assert.equal(result.success, false); assert.equal(calls, 0); assert.equal(sceneFingerprint(fixture.scene), fingerprint)
  }
})


let checkpointStoreBundle: string | undefined
async function realCheckpointStore() {
  checkpointStoreBundle ??= (await build({
    entryPoints: [fileURLToPath(new URL('../workflows/workflowRunStore.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'inert-export-checkpoint-ports', setup(builder) {
      builder.onResolve({ filter: /^(axios|@shared\/stores\/appStore|@shared\/utils\/notification)$/ }, args => ({ path: args.path, namespace: 'inert' }))
      builder.onLoad({ filter: /.*/, namespace: 'inert' }, ({ path }) => ({ loader: 'ts', contents: path === 'axios'
        ? 'export default { create: () => ({ post: async () => { throw new Error("Unexpected network") } }) }'
        : path.endsWith('appStore') ? 'export const useAppStore = { getState: () => fixture.app }'
        : 'export const showCompletionNotification = () => {}; export const showErrorNotification = () => {}' }))
    } }],
  })).outputFiles[0].text
  const app = {
    apiUrl: 'http://inert.invalid', currentJob: null as Record<string, unknown> | null,
    setCurrentJob(job: Record<string, unknown>) { this.currentJob = job },
    updateCurrentJob(patch: Record<string, unknown>) { if (this.currentJob) this.currentJob = { ...this.currentJob, ...patch } },
  }
  const module = { exports: {} as { useWorkflowRunStore: typeof import('../workflows/workflowRunStore.ts').useWorkflowRunStore } }
  vm.runInNewContext(checkpointStoreBundle, {
    module, exports: module.exports, require: createRequire(import.meta.url), fixture: { app },
    window: { electron: { settings: { get: async () => ({ workspaceDir: '/inert-workspace' }) }, fs: { deleteDirectory: async () => ({ success: true }) } } },
    process, console, crypto, Blob, FormData, atob, setTimeout, clearTimeout, TextDecoder,
  })
  const workflow: Workflow = { id: 'export-checkpoint', name: 'Export checkpoint', description: '', createdAt: '', updatedAt: '',
    nodes: [
      { id: 'source', type: 'meshNode', position: { x: 0, y: 0 }, data: { enabled: true, params: { source: 'file', filePath: '/inert-workspace/Workflows/checkpoints/source.glb' } } },
      { id: 'wait', type: 'waitNode', position: { x: 0, y: 0 }, data: { enabled: true, params: {} } },
    ], edges: [{ id: 'source-wait', source: 'source', target: 'wait' }],
  }
  await module.exports.useWorkflowRunStore.getState().run(workflow, [])
  return { store: module.exports.useWorkflowRunStore, app, workflow }
}

for (const invalidation of ['none', 'cancel', 'reset', 'clear', 'publish', 'continue', 'new-run'] as const) {
  test(`real C owner CAS across deferred writer: ${invalidation}`, async () => {
    const { store, app, workflow } = await realCheckpointStore()
    const input = exportFixture()
    const owner = store.getState().getCheckpointOwner('wait')!
    assert.ok(owner, JSON.stringify(store.getState().runState))
    input.sourceArtifact = store.getState().checkpoints.wait.substitutionPoint!.inputArtifact
    input.workspaceDir = '/inert-workspace'
    input.editPlan = { ...input.editPlan, sourceArtifactId: owner.inputArtifactId, sourceVersionId: owner.inputVersionId }
    input.getCheckpointOwner = id => store.getState().getCheckpointOwner(id)
    let calls = 0
    input.setPendingReplacement = (captured, artifact) => { calls++; return store.getState().setPendingReplacement(captured, artifact) }
    let finish!: () => void
    let started = false
    input.writer = request => new Promise(resolve => {
      started = true
      finish = () => resolve({ success: true, glbWorkspacePath: request.glbWorkspacePath, sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata })
    })
    const saving = saveEditedScenePendingReplacement(input)
    for (let i = 0; i < 20 && !started; i++) await Promise.resolve()
    assert.equal(started, true)
    if (invalidation === 'cancel' || invalidation === 'reset') store.getState()[invalidation]()
    if (invalidation === 'clear') assert.equal(store.getState().setPendingReplacement(owner, undefined), true)
    if (invalidation === 'publish') assert.equal(store.getState().setPendingReplacement(owner, { ...input.sourceArtifact, versionId: 'new-edit' }), true)
    if (invalidation === 'continue') await store.getState().continueRun('wait')
    if (invalidation === 'new-run') await store.getState().run(workflow, [])
    const before = JSON.stringify({ state: store.getState(), job: app.currentJob })
    finish()
    const result = await saving
    assert.equal(result.success, true, JSON.stringify(result))
    if (result.success) assert.equal(result.status, invalidation === 'none' ? 'pending-replacement-set' : 'saved-unselected')
    assert.equal(calls, 1)
    if (invalidation === 'none') {
      assert.equal(store.getState().checkpoints.wait.pendingReplacement?.uri, result.success ? result.glbWorkspacePath : undefined)
      assert.equal(store.getState().getCheckpointOwner('wait')?.revision, owner.revision + 1)
    } else assert.equal(JSON.stringify({ state: store.getState(), job: app.currentJob }), before)
  })
}

test('collision IDs exclude exactly one ordinary subtree, not its normalized sibling', async () => {
  const scene = makeScene()
  scene.children[0].name = 'a b'; scene.children[1].name = 'a_b'
  scene.children[0].add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()))
  const parts = collectSceneParts(scene)
  const result = await exportEditedSceneArtifact({ scene, parts, createdAt: '2026-10-06T12:00:00Z',
    editPlan: createEditPlan({ sourceArtifactId: 'source', sourceWorkspacePath: 'Workflows/source.glb', excludedPartIds: [parts[0].id] }),
    exporter: { parse(clone, done) { assert.equal(clone.children.length, 1); assert.equal(clone.children[0].name, 'a_b'); done(new Uint8Array([1]).buffer) } },
    writer: async request => ({ success: true, glbWorkspacePath: request.glbWorkspacePath, sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata }) })
  assert.equal(result.success, true); assert.equal(scene.children.length, 2); assert.equal(scene.children[0].children.length, 1)
})


test('selection rejects foreign objects and forged selectable rig parts', () => {
  const scene = makeScene()
  assert.equal(resolveScenePartIdForObject({ scene, target: makeScene().children[0], parts: collectSceneParts(scene) }), null)
  const bone = new Bone(); scene.add(bone)
  const parts = collectSceneParts(scene).map(part => ({ ...part, selectable: true, guardrail: { status: 'allowed' as const } }))
  assert.equal(resolveScenePartIdForObject({ scene, target: bone, parts }), null)
})

test('mismatched writer paths and rejected writers never publish and never dispose source resources', async () => {
  for (const failure of ['reject', 'mismatch']) {
    const input = exportFixture()
    const mesh = input.scene.children[0] as Mesh
    let disposals = 0; mesh.geometry.addEventListener('dispose', () => { disposals++ })
    let publication = 0; input.setPendingReplacement = () => { publication++; return true }
    input.writer = async request => {
      if (failure === 'reject') throw new Error('rejected writer')
      return { success: true, glbWorkspacePath: '/outside/edit.glb', sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata }
    }
    const result = await saveEditedScenePendingReplacement(input)
    assert.equal(result.success, false); assert.equal(disposals, 0); assert.equal(publication, 0)
  }
})


async function withExportFileReader<T>(work: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
  class MemoryFileReader {
    result: ArrayBuffer | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(buffer => { this.result = buffer; this.onloadend?.() }) }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: MemoryFileReader })
  try { return await work() } finally {
    if (previous) Object.defineProperty(globalThis, 'FileReader', previous)
    else Reflect.deleteProperty(globalThis, 'FileReader')
  }
}

async function exportAndLoadScene(input: Parameters<typeof exportEditedSceneArtifact>[0]) {
  let bytes: Uint8Array | undefined
  const result = await exportEditedSceneArtifact({ ...input, exporter: new GLTFExporter(),
    writer: async request => {
      bytes = request.bytes instanceof Uint8Array ? request.bytes : new Uint8Array(request.bytes)
      return { success: true, glbWorkspacePath: request.glbWorkspacePath, sidecarWorkspacePath: request.sidecarWorkspacePath, metadata: request.metadata }
    },
  })
  assert.equal(result.success, true, JSON.stringify(result)); assert.ok(bytes)
  return new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '')
}

function assertMatrixNear(actual: Matrix4, expected: Matrix4) {
  for (let index = 0; index < 16; index++) {
    assert.ok(Math.abs(actual.elements[index] - expected.elements[index]) < 1e-6,
      `matrix element ${index}: ${actual.elements[index]} differs from ${expected.elements[index]}`)
  }
}

test('regression E1: real roundtrip retains both roots of one shared clip and blocks either exclusion', async () => withExportFileReader(async () => {
  const input = exportFixture()
  const first = new Object3D(); first.name = 'First'
  const second = new Object3D(); second.name = 'Second'
  const clip = new AnimationClip('Shared', 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 2, 0, 0])])
  first.animations = [clip, clip]; second.animations = [clip]
  input.scene.add(first, second)
  input.parts = collectSceneParts(input.scene)
  const before = sceneFingerprint(input.scene)
  const loaded = await exportAndLoadScene(input)
  assert.deepEqual(loaded.animations.flatMap(animation => animation.tracks.map(track => track.name)).sort(), ['First.position', 'Second.position'])
  const mixer = new AnimationMixer(loaded.scene)
  for (const animation of loaded.animations) mixer.clipAction(animation).play()
  mixer.setTime(0.5)
  assert.equal(loaded.scene.getObjectByName('First')?.position.x, 1)
  assert.equal(loaded.scene.getObjectByName('Second')?.position.x, 1)
  for (const node of [first, second]) {
    const result = await exportEditedSceneArtifact({ ...input, editPlan: { ...input.editPlan, excludedPartIds: [input.parts.find(part => part.label === node.name)!.id] } })
    assert.equal(result.success, false)
  }
  assert.equal(sceneFingerprint(input.scene), before)
  assert.deepEqual(clip.tracks[0].name, '.position')
}))

for (const animated of [false, true]) {
  test(`regression E2: Scene root transform and root animation survive real rig roundtrip (${animated})`, async () => withExportFileReader(async () => {
    const fixture = rigFixture()
    const scene = new Scene()
    scene.name = 'SceneRoot'
    scene.add(...fixture.scene.children.slice())
    scene.position.set(5, 2, -3); scene.scale.set(2, 3, 4); scene.rotation.z = 0.35
    const rootClip = new AnimationClip('RootMotion', 1, [new VectorKeyframeTrack('.position', [0, 1], [5, 2, -3, 7, 2, -3])])
    if (animated) scene.animations = [rootClip]
    scene.updateMatrixWorld(true)
    const expected = fixture.staticB.matrixWorld.clone()
    const before = sceneFingerprint(scene)
    const loaded = await exportAndLoadScene({ ...exportFixture(), scene, parts: collectSceneParts(scene),
      animationClips: animated ? [fixture.clip] : [],
      editPlan: { ...fixture.editPlan, excludedPartIds: [collectSceneParts(scene).find(part => part.label === 'Remove')!.id] },
    })
    loaded.scene.updateMatrixWorld(true)
    assertMatrixNear(loaded.scene.getObjectByName('StaticB')!.matrixWorld, expected)
    assert.ok(loaded.scene.getObjectByName('SceneRoot'))
    if (animated) {
      const rootMotion = loaded.animations.find(clip => clip.name === 'RootMotion')!
      assert.equal(rootMotion.tracks[0].name, 'SceneRoot.position')
      const mixer = new AnimationMixer(loaded.scene); mixer.clipAction(rootMotion).play(); mixer.setTime(0.5)
      assert.equal(loaded.scene.getObjectByName('SceneRoot')!.position.x, 6)
      assert.equal(loaded.animations.find(clip => clip.name === 'JointMotion')?.tracks[0].name, 'Tip.position')
    }
    assert.equal(sceneFingerprint(scene), before)
  }))
}

test('regression E3: animated rig preserves a manual matrix with rotation and signed nonuniform scale', async () => withExportFileReader(async () => {
  const fixture = rigFixture()
  fixture.staticB.matrixAutoUpdate = false
  fixture.staticB.matrix.compose(new Vector3(7, 8, 9), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7), new Vector3(-2, 3, 0.5))
  fixture.scene.updateMatrixWorld(true)
  const expected = fixture.staticB.matrixWorld.clone()
  const before = sceneFingerprint(fixture.scene)
  const loaded = await exportAndLoadScene({ ...exportFixture(), ...fixture, animationClips: [fixture.clip] })
  loaded.scene.updateMatrixWorld(true)
  assertMatrixNear(loaded.scene.getObjectByName('StaticB')!.matrixWorld, expected)
  assert.equal(loaded.animations.length, 1)
  assert.equal(sceneFingerprint(fixture.scene), before)
}))

test('regression E3: animated export rejects a nonrepresentable manual shear before writer', async () => {
  const fixture = rigFixture()
  fixture.staticB.matrixAutoUpdate = false
  fixture.staticB.matrix.makeShear(0.3, 0, 0, 0, 0, 0)
  const before = sceneFingerprint(fixture.scene)
  let exports = 0; let writes = 0
  const result = await exportEditedSceneArtifact({ ...exportFixture(), ...fixture, animationClips: [fixture.clip],
    exporter: { parse(_scene, done) { exports++; done(new Uint8Array([1]).buffer) } },
    writer: async () => { writes++; return { success: false, error: 'should not write' } },
  })
  assert.equal(result.success, false)
  if (!result.success) assert.match(result.error, /manual matrix.*TRS|TRS.*manual matrix/i)
  assert.equal(exports, 0); assert.equal(writes, 0)
  assert.equal(sceneFingerprint(fixture.scene), before)
})

for (const save of [false, true]) {
  test(`regression E4: export captures its writer before await (${save ? 'checkpoint' : 'standalone'})`, async () => {
    const input = exportFixture()
    let done!: (buffer: ArrayBuffer) => void
    input.exporter = { parse(_scene, onDone) { done = onDone } }
    let original = 0; let redirected = 0
    const writer = input.writer
    input.writer = request => { original++; return writer(request) }
    const pending = save ? saveEditedScenePendingReplacement(input) : exportEditedSceneArtifact(input)
    input.writer = request => { redirected++; return writer(request) }
    done(new Uint8Array([1]).buffer)
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(original, 1); assert.equal(redirected, 0)
  })
}

test('regression local-matrix: nonanimated shear rejects before exporter, writer, registration or publication', async () => {
  const input = exportFixture()
  const keep = input.scene.children[0] as Mesh
  keep.matrixAutoUpdate = false
  keep.matrix.set(1, 0.4, 0, 3, 0, 1, 0, 4, 0, 0, 1, 5, 0, 0, 0, 1)
  const before = sceneFingerprint(input.scene)
  const geometry = keep.geometry; const material = keep.material
  let exports = 0; let writes = 0; let registrations = 0; let publications = 0; let disposals = 0
  geometry.addEventListener('dispose', () => { disposals++ })
  assert.ok(material instanceof Material)
  material.addEventListener('dispose', () => { disposals++ })
  const result = await saveEditedScenePendingReplacement({ ...input,
    exporter: { parse(_scene, done) { exports++; done(new Uint8Array([1]).buffer) } },
    writer: request => { writes++; return input.writer(request) },
    registerEditedArtifact: () => { registrations++; return { success: false, error: 'must not register' } },
    setPendingReplacement: () => { publications++; return true },
  })
  assert.equal(result.success, false)
  if (!result.success) {
    assert.equal(result.stage, 'export')
    assert.match(result.error, /Cannot preserve manual matrix as TRS/)
  }
  assert.deepEqual([exports, writes, registrations, publications, disposals], [0, 0, 0, 0, 0])
  assert.equal(keep.geometry, geometry); assert.equal(keep.material, material)
  assert.equal(keep.matrixAutoUpdate, false)
  assert.equal(sceneFingerprint(input.scene), before)
})

test('regression local-matrix: nonanimated reflected nonuniform manual TRS roundtrips', async () => withExportFileReader(async () => {
  const input = exportFixture()
  const keep = input.scene.children[0]
  keep.name = 'Kept'; keep.matrixAutoUpdate = false
  keep.position.set(77, 88, 99)
  keep.matrix.compose(new Vector3(3, 4, 5), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7), new Vector3(-1.5, 2, 0.7))
  input.parts = collectSceneParts(input.scene)
  input.scene.updateMatrixWorld(true)
  const expected = keep.matrixWorld.clone(); const before = sceneFingerprint(input.scene)
  const loaded = await exportAndLoadScene(input)
  loaded.scene.updateMatrixWorld(true)
  assert.equal(loaded.animations.length, 0)
  assertMatrixNear(loaded.scene.getObjectByName('Kept')!.matrixWorld, expected)
  assert.equal(sceneFingerprint(input.scene), before)
}))

test('regression local-matrix: valid local TRS hierarchy may produce world shear without flattening', async () => withExportFileReader(async () => {
  const input = exportFixture()
  input.scene.name = 'ScaledParent'; input.scene.scale.set(2, 3, 0.5)
  const keep = input.scene.children[0]
  keep.name = 'RotatedChild'; keep.matrixAutoUpdate = false
  keep.matrix.makeRotationZ(0.7)
  input.parts = collectSceneParts(input.scene)
  input.editPlan = { ...input.editPlan, excludedPartIds: [input.parts.find(part => part.label === 'Remove mesh')!.id] }
  input.scene.updateMatrixWorld(true)
  const expected = keep.matrixWorld.clone(); const before = sceneFingerprint(input.scene)
  const position = new Vector3(); const quaternion = new Quaternion(); const scale = new Vector3()
  expected.decompose(position, quaternion, scale)
  const reconstructed = new Matrix4().compose(position, quaternion, scale)
  assert.ok(expected.elements.some((value, index) => Math.abs(value - reconstructed.elements[index]) > 1e-3))
  const loaded = await exportAndLoadScene(input)
  loaded.scene.updateMatrixWorld(true)
  const child = loaded.scene.getObjectByName('RotatedChild')!
  assert.equal(child.parent?.name, 'ScaledParent')
  assertMatrixNear(child.matrixWorld, expected)
  assert.equal(sceneFingerprint(input.scene), before)
}))

test('regression local-matrix: excluded unsupported subtree does not block valid nonanimated export', async () => withExportFileReader(async () => {
  const input = exportFixture()
  const excluded = input.scene.children[1]
  const child = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  child.name = 'ExcludedShear'; child.matrixAutoUpdate = false; child.matrix.makeShear(0.4, 0, 0, 0, 0, 0)
  excluded.add(child)
  input.parts = collectSceneParts(input.scene)
  const before = sceneFingerprint(input.scene)
  const loaded = await exportAndLoadScene(input)
  assert.equal(loaded.scene.getObjectByName('ExcludedShear'), undefined)
  let meshes = 0; loaded.scene.traverse(node => { if (node instanceof Mesh) meshes++ })
  assert.equal(meshes, 1)
  assert.equal(sceneFingerprint(input.scene), before)
}))
