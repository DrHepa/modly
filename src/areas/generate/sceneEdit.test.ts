import assert from 'node:assert/strict'
import test from 'node:test'
import { AnimationClip, VectorKeyframeTrack, Bone, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, SkinnedMesh } from 'three'

import {
  SCENE_EDIT_ACTION_LABELS,
  collectSceneParts,
  collectSceneAnimations,
  createEditPlan,
  editPlanReducer,
  isEditPlanExportable,
} from './sceneEdit.ts'
import type { EditPlan, SceneEditExportResult, ScenePart, WorkspaceArtifactWriteResult } from './sceneEdit.types.ts'
import { resolveCheckpointEditEligibility } from './viewerModelSource.ts'

function namedMesh(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xffffff }))
  mesh.name = name
  return mesh
}

test('scene edit types expose explicit plan, part, and discriminated result unions', () => {
  const part: ScenePart = {
    id: 'node:0/mesh:Wheel#0',
    label: 'Wheel',
    type: 'mesh',
    path: ['Root', 'Wheel'],
    siblingIndex: 0,
    selectable: true,
    guardrail: { status: 'allowed' },
  }
  const plan: EditPlan = {
    sourceArtifactId: 'artifact-1',
    sourceVersionId: 'version-1',
    sourceWorkspacePath: 'Workflows/checkpoints/wait.glb',
    selectedPartId: part.id,
    excludedPartIds: [part.id],
  }
  const exportResult: SceneEditExportResult = { success: true, bytes: new Uint8Array([1, 2, 3]) }
  const writeResult: WorkspaceArtifactWriteResult = { success: false, error: 'workspace path rejected' }

  assert.equal(plan.excludedPartIds[0], part.id)
  assert.equal(exportResult.success, true)
  assert.deepEqual(Array.from(exportResult.bytes), [1, 2, 3])
  assert.equal(writeResult.success, false)
  assert.equal(writeResult.error, 'workspace path rejected')
})

test('resolveCheckpointEditEligibility allows only checkpoint mesh previews with safe workspace-relative source paths', () => {
  const eligible = resolveCheckpointEditEligibility({
    modelSource: {
      kind: 'workflow-checkpoint',
      modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
    },
    artifact: { type: 'mesh', workspacePath: 'Workflows/checkpoints/wait.glb' },
  })

  assert.deepEqual(eligible, { eligible: true })
})

test('resolveCheckpointEditEligibility rejects final outputs, non-mesh artifacts, missing checkpoints, and traversal paths', () => {
  const finalOutput = resolveCheckpointEditEligibility({
    modelSource: { kind: 'final', modelUrl: '/workspace/final.glb', isCheckpointPreview: false, label: 'Final output' },
    artifact: { type: 'mesh', workspacePath: 'Workflows/final.glb' },
  })
  const nonMesh = resolveCheckpointEditEligibility({
    modelSource: {
      kind: 'workflow-checkpoint',
      modelUrl: '/workspace/checkpoints/preview.png',
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
    },
    artifact: { type: 'image', workspacePath: 'Workflows/checkpoints/preview.png' },
  })
  const noCheckpoint = resolveCheckpointEditEligibility({
    modelSource: { kind: 'none', modelUrl: null, isCheckpointPreview: false },
    artifact: { type: 'mesh', workspacePath: 'Workflows/checkpoints/wait.glb' },
  })
  const traversal = resolveCheckpointEditEligibility({
    modelSource: {
      kind: 'workflow-checkpoint',
      modelUrl: '/workspace/checkpoints/wait.glb',
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
    },
    artifact: { type: 'mesh', workspacePath: '../outside/wait.glb' },
  })

  assert.deepEqual(finalOutput, { eligible: false, reason: 'not-checkpoint-preview' })
  assert.deepEqual(nonMesh, { eligible: false, reason: 'not-mesh-artifact' })
  assert.deepEqual(noCheckpoint, { eligible: false, reason: 'not-checkpoint-preview' })
  assert.deepEqual(traversal, { eligible: false, reason: 'unsafe-workspace-path' })
})

test('collectSceneParts creates stable IDs from traversal path, name, type, and sibling index without Object3D.uuid', () => {
  const root = new Object3D()
  root.name = 'Root'
  const group = new Object3D()
  group.name = 'Vehicle Body'
  const wheelA = namedMesh('Wheel')
  const wheelB = namedMesh('Wheel')
  group.add(wheelA, wheelB)
  root.add(group)

  const parts = collectSceneParts(root)

  assert.deepEqual(
    parts.map((part) => part.id),
    [
      'node:Root#0/node:Vehicle_Body#0',
      'node:Root#0/node:Vehicle_Body#0/mesh:Wheel#0',
      'node:Root#0/node:Vehicle_Body#0/mesh:Wheel#1',
    ],
  )
  assert.equal(parts[1].label, 'Wheel')
  assert.equal(parts[1].id.includes(wheelA.uuid), false)
  assert.equal(parts[2].id.includes(wheelB.uuid), false)
})

test('editPlanReducer selects, excludes, unexcludes, resets, and clears excluded part IDs idempotently', () => {
  const plan = createEditPlan({
    sourceArtifactId: 'artifact-1',
    sourceVersionId: 'version-1',
    sourceWorkspacePath: 'Workflows/checkpoints/wait.glb',
  })

  const selected = editPlanReducer(plan, { type: 'select-part', partId: 'mesh:Wheel#0' })
  const excludedOnce = editPlanReducer(selected, { type: 'exclude-selected-part' })
  const excludedTwice = editPlanReducer(excludedOnce, { type: 'exclude-selected-part' })
  const unexcluded = editPlanReducer(excludedTwice, { type: 'unexclude-part', partId: 'mesh:Wheel#0' })
  const excludedAgain = editPlanReducer(unexcluded, { type: 'exclude-part', partId: 'mesh:Door#0' })
  const reset = editPlanReducer(excludedAgain, { type: 'reset' })
  const cleared = editPlanReducer(excludedAgain, { type: 'clear' })

  assert.equal(selected.selectedPartId, 'mesh:Wheel#0')
  assert.deepEqual(excludedOnce.excludedPartIds, ['mesh:Wheel#0'])
  assert.deepEqual(excludedTwice.excludedPartIds, ['mesh:Wheel#0'])
  assert.deepEqual(unexcluded.excludedPartIds, [])
  assert.deepEqual(reset.excludedPartIds, [])
  assert.equal(reset.selectedPartId, 'mesh:Wheel#0')
  assert.deepEqual(cleared.excludedPartIds, [])
  assert.equal(cleared.selectedPartId, undefined)
})

test('guardrails flag skinned meshes, bones, armatures, and animation dependencies as non-exportable exclusions', () => {
  const root = new Object3D()
  root.name = 'Root'
  const bone = new Bone()
  bone.name = 'Spine'
  const armature = new Object3D()
  armature.name = 'Armature'
  const skinned = new SkinnedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xffffff }))
  skinned.name = 'CharacterBody'
  const animated = namedMesh('AnimatedDoor')
  root.add(bone, armature, skinned, animated)

  const parts = collectSceneParts(root, { animationClips: [new AnimationClip('open-door', 1, [])], animatedNodeNames: ['AnimatedDoor'] })
  const blockedIds = parts.filter((part) => part.guardrail.status === 'blocked').map((part) => part.id)
  const blockedPlan = createEditPlan({
    sourceArtifactId: 'artifact-1',
    sourceVersionId: 'version-1',
    sourceWorkspacePath: 'Workflows/checkpoints/wait.glb',
    excludedPartIds: blockedIds,
  })

  assert.deepEqual(
    parts.map((part) => [
      part.label,
      part.guardrail.status,
      part.guardrail.status === 'blocked' ? part.guardrail.reason : 'allowed',
    ]),
    [
      ['Spine', 'blocked', 'bone'],
      ['Armature', 'blocked', 'armature'],
      ['CharacterBody', 'blocked', 'skinned-mesh'],
      ['AnimatedDoor', 'blocked', 'animation-dependency'],
    ],
  )
  assert.deepEqual(isEditPlanExportable(blockedPlan, parts), {
    exportable: false,
    blockedPartIds: blockedIds,
  })
})

test('copy labels describe reversible hiding or export exclusion, never deletion', () => {
  assert.deepEqual(SCENE_EDIT_ACTION_LABELS, {
    hideFromEditedCopy: 'Hide from edited copy',
    excludeFromExport: 'Exclude from export',
    reset: 'Reset edit plan',
    clear: 'Clear selection',
  })
  assert.equal(Object.values(SCENE_EDIT_ACTION_LABELS).some((label) => /delete/i.test(label)), false)
})


test('normalized sibling name collisions retain distinct stable IDs on a clone', () => {
  const root = new Object3D()
  for (const name of ['a b', 'a_b', 'a/b', 'a_b']) root.add(namedMesh(name))
  const ids = collectSceneParts(root).map(part => part.id)
  assert.equal(new Set(ids).size, 4)
  assert.deepEqual(collectSceneParts(root.clone()).map(part => part.id), ids)
})

test('ordinary parents containing rig or animation dependencies are blocked but static subtrees stay editable', () => {
  const root = new Object3D()
  const rigGroup = new Object3D(); rigGroup.name = 'Character'
  const nested = new Object3D(); nested.name = 'Nested'
  const bone = new Bone(); bone.name = 'Joint'
  nested.add(bone); rigGroup.add(nested)
  const animatedGroup = new Object3D(); animatedGroup.name = 'MovingGroup'
  const target = namedMesh('Animated'); animatedGroup.add(target)
  const staticGroup = new Object3D(); staticGroup.name = 'StaticGroup'; staticGroup.add(namedMesh('Decoration'))
  root.add(rigGroup, animatedGroup, staticGroup)
  const clip = new AnimationClip('move', 1, [new VectorKeyframeTrack(`${target.uuid}.position`, [0, 1], [0, 0, 0, 1, 2, 3])])
  for (const parts of [collectSceneParts(root, { animationClips: [clip] }), (() => { root.animations = [clip]; return collectSceneParts(root) })()]) {
    for (const name of ['Character', 'Nested', 'Joint', 'MovingGroup', 'Animated']) {
      assert.equal(parts.find(part => part.label === name)?.guardrail.status, 'blocked', name)
    }
    for (const name of ['StaticGroup', 'Decoration']) assert.equal(parts.find(part => part.label === name)?.selectable, true, name)
  }
})


test('regression E1: shared clips retain distinct binding roots and deduplicate only repeated pairs', () => {
  const root = new Object3D()
  const first = new Object3D(); first.name = 'First'
  const second = new Object3D(); second.name = 'Second'
  const clip = new AnimationClip('Shared', 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0])])
  root.animations = [clip]; first.animations = [clip, clip]; second.animations = [clip]
  root.add(first, second, namedMesh('Static'))
  const bindings = collectSceneAnimations(root, [clip, clip])
  assert.deepEqual(bindings.map(binding => binding.root), [root, first, second])
  assert.ok(bindings.every(binding => binding.clip === clip))
  const parts = collectSceneParts(root, { animationClips: [clip, clip] })
  assert.equal(parts.find(part => part.label === 'First')?.selectable, false)
  assert.equal(parts.find(part => part.label === 'Second')?.selectable, false)
  assert.equal(parts.find(part => part.label === 'Static')?.selectable, true)
})
