import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addWorldCollisionZone,
  appendWorldSceneItem,
  attachWorldSceneItemAnimation,
  calculateBaseSceneAnchor,
  calculateWorldSceneItemPlacementOffset,
  createWorldSceneSelectionTransformUpdates,
  removeWorldCollisionZone,
  resolveWorldSceneItemForPoseClip,
  resolveWorldCollisionZonePlacementAnchor,
  updateWorldCollisionZoneTransform,
  updateWorldSceneItemTransforms,
} from './worldsScenePlacement.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

function item(id: string, workspacePath = 'Workflows/hero.glb'): WorldSceneItem {
  return {
    id,
    workspacePath,
    url: `/workspace/${workspacePath}`,
    kind: workspacePath.endsWith('.gltf') ? 'gltf' : 'glb',
    role: 'asset',
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
}

test('resolveWorldSceneItemForPoseClip prefers the selected matching linked source, otherwise first match', () => {
  const items = [item('first'), item('selected'), item('other', 'Workflows/other.glb')]

  assert.equal(resolveWorldSceneItemForPoseClip(items, 'Workflows/hero.glb', 'selected')?.id, 'selected')
  assert.equal(resolveWorldSceneItemForPoseClip(items, 'Workflows/hero.glb', null)?.id, 'first')
  assert.equal(resolveWorldSceneItemForPoseClip(items, 'Workflows/missing.glb', 'selected'), null)
})

test('attachWorldSceneItemAnimation attaches serializable pose-clip binding without mutating source items', () => {
  const original = item('hero')
  const animation = { kind: 'pose-clip' as const, sidecarWorkspacePath: 'Motions/walk.json', sourceWorkspacePath: 'Workflows/hero.glb' }
  const result = attachWorldSceneItemAnimation([original], 'hero', animation)

  assert.equal(original.animation, undefined)
  assert.deepEqual(result[0].animation, animation)
})

test('appendWorldSceneItem prefers the selected item anchor before base-scene averages', () => {
  const selected = { ...item('selected', 'Workflows/selected.glb'), transform: { position: [10, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  const base = { ...item('base', 'Workflows/base.glb'), role: 'base-scene' as const, transform: { position: [50, 1, -20], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  const prop = item('prop', 'Workflows/prop.glb')

  const appended = appendWorldSceneItem([selected, base], prop, {
    selectedSceneItemId: selected.id,
    sceneItemAnchors: {
      [selected.id]: [12, 3, 8],
      [base.id]: [40, 2, -10],
    },
  })

  assert.deepEqual(appended.sceneItems[2]?.transform.position, [12, 3, 9.75])
})

test('appendWorldSceneItem falls back to selected item transform, then base-scene average, then origin', () => {
  const selected = { ...item('selected', 'Workflows/selected.glb'), transform: { position: [6, 4, -2], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  const baseA = { ...item('base-a', 'Workflows/base-a.glb'), role: 'base-scene' as const, transform: { position: [10, 0, -4], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  const baseB = { ...item('base-b', 'Workflows/base-b.glb'), role: 'base-scene' as const, transform: { position: [14, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  const prop = item('prop', 'Workflows/prop.glb')

  assert.deepEqual(appendWorldSceneItem([selected], prop, { selectedSceneItemId: selected.id }).sceneItems[1]?.transform.position, [7.75, 4, -2])
  assert.deepEqual(appendWorldSceneItem([baseA, baseB], prop, {
    sceneItemAnchors: {
      [baseA.id]: [40, 2, -20],
      [baseB.id]: [44, 2, -16],
    },
  }).sceneItems[2]?.transform.position, [43.75, 2, -18])
  assert.deepEqual(appendWorldSceneItem([], prop).sceneItems[0]?.transform.position, [0, 0, 0])
  assert.deepEqual(calculateBaseSceneAnchor([baseA, baseB], {
    [baseA.id]: [40, 2, -20],
    [baseB.id]: [44, 2, -16],
  }), [42, 2, -18])
})

test('calculateWorldSceneItemPlacementOffset stays locally bounded and wraps instead of expanding outward forever', () => {
  assert.deepEqual(calculateWorldSceneItemPlacementOffset(0), [0, 0, 0])
  assert.deepEqual(calculateWorldSceneItemPlacementOffset(1), [1.75, 0, 0])
  assert.deepEqual(calculateWorldSceneItemPlacementOffset(2), [0, 0, 1.75])
  assert.deepEqual(calculateWorldSceneItemPlacementOffset(8), [1.75, 0, -1.75])
  assert.deepEqual(calculateWorldSceneItemPlacementOffset(9), [1.75, 0, 0])
  assert.deepEqual(calculateWorldSceneItemPlacementOffset(17), [1.75, 0, 0])
})

test('createWorldSceneSelectionTransformUpdates translates all selected items by the active position delta', () => {
  const updates = createWorldSceneSelectionTransformUpdates({
    mode: 'translate',
    activeItemId: 'active',
    snapshot: [
      { itemId: 'active', transform: { position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { itemId: 'secondary', transform: { position: [4, 1, -1], rotation: [0.2, 0.4, 0.6], scale: [2, 3, 4] } },
    ],
    activeTransform: { position: [3, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })

  assert.deepEqual(updates, [
    { itemId: 'active', transform: { position: [3, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { itemId: 'secondary', transform: { position: [6, 3, 2], rotation: [0.2, 0.4, 0.6], scale: [2, 3, 4] } },
  ])
})

test('createWorldSceneSelectionTransformUpdates rotates secondary positions and rotations around the active pivot', () => {
  const quarterTurn = Math.PI / 2
  const updates = createWorldSceneSelectionTransformUpdates({
    mode: 'rotate',
    activeItemId: 'active',
    snapshot: [
      { itemId: 'active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { itemId: 'secondary', transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ],
    activeTransform: { position: [0, 0, 0], rotation: [0, quarterTurn, 0], scale: [1, 1, 1] },
  })

  assert.equal(updates[1]?.itemId, 'secondary')
  assert.ok(updates[1])
  assert.ok(Math.abs(updates[1]!.transform.position[0]) < 1e-6)
  assert.ok(Math.abs(updates[1]!.transform.position[1]) < 1e-6)
  assert.ok(Math.abs(updates[1]!.transform.position[2] + 2) < 1e-6)
  assert.ok(Math.abs(updates[1]!.transform.rotation[1] - quarterTurn) < 1e-6)
})

test('createWorldSceneSelectionTransformUpdates scales secondary offsets and scales around the active local axes without changing rotation', () => {
  const updates = createWorldSceneSelectionTransformUpdates({
    mode: 'scale',
    activeItemId: 'active',
    snapshot: [
      { itemId: 'active', transform: { position: [10, 0, -4], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] } },
      { itemId: 'secondary', transform: { position: [10, 0, -2], rotation: [0.3, 0.2, 0.1], scale: [2, 3, 4] } },
    ],
    activeTransform: { position: [10, 0, -4], rotation: [0, Math.PI / 2, 0], scale: [2, 1, 0.5] },
  })

  assert.deepEqual(updates, [
    { itemId: 'active', transform: { position: [10, 0, -4], rotation: [0, Math.PI / 2, 0], scale: [2, 1, 0.5] } },
    { itemId: 'secondary', transform: { position: [10, 0, 0], rotation: [0.3, 0.2, 0.1], scale: [4, 3, 2] } },
  ])
})

test('updateWorldSceneItemTransforms applies batched updates without mutating untouched items', () => {
  const active = item('active')
  const secondary = item('secondary', 'Workflows/secondary.glb')
  const untouched = item('untouched', 'Workflows/untouched.glb')

  const result = updateWorldSceneItemTransforms([active, secondary, untouched], [
    { itemId: 'active', transform: { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] } },
    { itemId: 'secondary', transform: { position: [4, 5, 6], rotation: [0.4, 0.5, 0.6], scale: [3, 3, 3] } },
  ])

  assert.deepEqual(result, [
    { ...active, transform: { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] } },
    { ...secondary, transform: { position: [4, 5, 6], rotation: [0.4, 0.5, 0.6], scale: [3, 3, 3] } },
    untouched,
  ])
})

test('collision placement helpers add, anchor, update, and remove scene-level world zones', () => {
  const hero = { ...item('hero'), transform: { position: [4, 1, -2], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  const base = { ...item('base', 'Workflows/base.glb'), role: 'base-scene' as const, transform: { position: [10, 0, -4], rotation: [0, 0, 0], scale: [1, 1, 1] } }

  assert.deepEqual(resolveWorldCollisionZonePlacementAnchor([], [hero], { selectedSceneItemId: hero.id }), [4, 1, -2])
  assert.deepEqual(resolveWorldCollisionZonePlacementAnchor([], [base], { sceneItemAnchors: { [base.id]: [12, 2, -8] } }), [12, 2, -8])

  const added = addWorldCollisionZone([], 'blocker', { anchorPosition: [4, 1, -2] })
  assert.equal(added.selectedCollisionZoneId, 'collision-box-1')
  assert.deepEqual(added.collisionZones, [{
    id: 'collision-box-1',
    label: 'Blocker 1',
    shape: 'box',
    preset: 'blocker',
    transform: { position: [4, 1, -2], rotation: [0, 0, 0], scale: [1.2, 1.2, 1.2] },
  }])

  assert.deepEqual(updateWorldCollisionZoneTransform(added.collisionZones, 'collision-box-1', {
    position: [2, 3, 4],
    rotation: [0.1, 0.2, 0.3],
    scale: [5, 0.01, 7],
  }), [{
    id: 'collision-box-1',
    label: 'Blocker 1',
    shape: 'box',
    preset: 'blocker',
    transform: { position: [2, 3, 4], rotation: [0.1, 0.2, 0.3], scale: [5, 0.05, 7] },
  }])

  assert.deepEqual(removeWorldCollisionZone(added.collisionZones, 'collision-box-1'), {
    collisionZones: [],
    selectedCollisionZoneId: null,
  })
})
