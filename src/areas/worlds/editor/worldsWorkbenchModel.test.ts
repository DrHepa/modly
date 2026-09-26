import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorldEntity, WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import type { WorldRenderableComponent } from '../core/worldComponentRegistry.ts'
import {
  buildInspectorComponentReplacement,
  buildWorldTreeMutationCommands,
  createWorldTreeRows,
  getVisibleWorldInspectorFields,
  getWorldsDockFocusFallbackSelector,
  parseWorldInspectorNumber,
  reduceWorldTreeKeyboard,
  resolveWorldsPersistenceIndicator,
  resolveWorldsFocusTrapIndex,
  reduceWorldsNumericDraft,
  selectWorldTreeEntity,
  shouldIncludeWorldsFocusCandidate,
  shouldHandleWorldTreeRowKeyEvent,
  snapWorldInspectorValue,
} from './worldsWorkbenchModel.ts'
import { buildPatchEntityTransformsCommands } from './worldEditorCommandBuilders.ts'

test('clearing optional character jump omits the property from canonical JSON', () => {
  const component = {
    id: 'component:character', type: 'character-controller' as const, enabled: true,
    colliderComponentId: 'component:capsule', moveActionId: 'input:move', jumpActionId: 'input:jump',
    speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45,
  }
  const cleared = buildInspectorComponentReplacement(component, 'jumpActionId', null)
  assert.equal(Object.hasOwn(cleared, 'jumpActionId'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(cleared)), cleared)
  assert.equal(component.jumpActionId, 'input:jump')
})

function entity(id: string, parentId: string | null = null, overrides: Partial<WorldEntity> = {}): WorldEntity {
  return {
    id,
    name: id,
    parentId,
    enabled: true,
    locked: false,
    tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [],
    ...overrides,
  }
}

function snapshot(entities: WorldEntity[]): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:ui', name: 'UI', revision: 4,
      resources: [{ id: 'resource:model', type: 'model', name: 'Model', workspacePath: 'Exports/model.glb', format: 'glb' }],
      scenes: [{ id: 'scene:one', name: 'Scene', documentPath: 'Worlds/world-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scenes/scene-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.world-scene.json' }],
      startSceneId: 'scene:one', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:one', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'msaa' }],
      activeGraphicsProfileId: 'graphics:one',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: 'project:ui', sceneId: 'scene:one', name: 'Scene',
      environment: { backgroundColor: '#20242b', ambientIntensity: 0.35 }, entities, sequences: [],
    }],
  }
}

test('tree rows preserve authored hierarchy order and WAI keyboard navigation expands and follows parents', () => {
  const rows = createWorldTreeRows([
    entity('entity:root-a'),
    entity('entity:child-a', 'entity:root-a'),
    entity('entity:root-b'),
  ], new Set())
  assert.deepEqual(rows.map((row) => row.id), ['entity:root-a', 'entity:root-b'])

  const expanded = reduceWorldTreeKeyboard({ rows, focusedId: 'entity:root-a', expandedIds: new Set() }, 'ArrowRight')
  assert.deepEqual([...expanded.expandedIds], ['entity:root-a'])
  const expandedRows = createWorldTreeRows([
    entity('entity:root-a'),
    entity('entity:child-a', 'entity:root-a'),
    entity('entity:root-b'),
  ], expanded.expandedIds)
  const child = reduceWorldTreeKeyboard({ rows: expandedRows, focusedId: 'entity:root-a', expandedIds: expanded.expandedIds }, 'ArrowRight')
  assert.equal(child.focusedId, 'entity:child-a')
  const parent = reduceWorldTreeKeyboard({ rows: expandedRows, focusedId: 'entity:child-a', expandedIds: expanded.expandedIds }, 'ArrowLeft')
  assert.equal(parent.focusedId, 'entity:root-a')
})

test('tree selection treats Ctrl and Meta as equivalent multi-select modifiers', () => {
  assert.deepEqual(selectWorldTreeEntity(['entity:a'], 'entity:b', { ctrlKey: true, metaKey: false }), ['entity:a', 'entity:b'])
  assert.deepEqual(selectWorldTreeEntity(['entity:a'], 'entity:b', { ctrlKey: false, metaKey: true }), ['entity:a', 'entity:b'])
  assert.deepEqual(selectWorldTreeEntity(['entity:a', 'entity:b'], 'entity:a', { ctrlKey: false, metaKey: true }), ['entity:b'])
  assert.deepEqual(selectWorldTreeEntity(['entity:a'], 'entity:b', { ctrlKey: false, metaKey: false }), ['entity:b'])
})

test('tree row navigation ignores keys owned by descendant controls', () => {
  const row = {}
  const button = {}
  assert.equal(shouldHandleWorldTreeRowKeyEvent(row, row), true)
  assert.equal(shouldHandleWorldTreeRowKeyEvent(button, row), false)
})

test('responsive overlay focus wraps in both Tab directions', () => {
  assert.equal(resolveWorldsFocusTrapIndex(3, 0, true), 2)
  assert.equal(resolveWorldsFocusTrapIndex(3, 2, false), 0)
  assert.equal(resolveWorldsFocusTrapIndex(3, 1, false), 2)
  assert.equal(resolveWorldsFocusTrapIndex(0, -1, false), null)
})

test('responsive overlay focus excludes hidden controls and resolves a visible wide-dock fallback', () => {
  assert.equal(shouldIncludeWorldsFocusCandidate({ ariaHidden: false, withinInert: false, clientRectCount: 1 }), true)
  assert.equal(shouldIncludeWorldsFocusCandidate({ ariaHidden: false, withinInert: false, clientRectCount: 0 }), false)
  assert.equal(shouldIncludeWorldsFocusCandidate({ ariaHidden: true, withinInert: false, clientRectCount: 1 }), false)
  assert.match(getWorldsDockFocusFallbackSelector('scene'), /data-worlds-dock="scene"/)
  assert.match(getWorldsDockFocusFallbackSelector('assets'), /data-worlds-dock="assets"/)
  assert.match(getWorldsDockFocusFallbackSelector('inspector'), /dock--right/)
})

test('persistence indicator reserves Conflict and recovery for revision conflicts', () => {
  assert.deepEqual(resolveWorldsPersistenceIndicator('loading', null), { status: 'saving', recoverable: false })
  assert.deepEqual(resolveWorldsPersistenceIndicator('error', 'revision_conflict'), { status: 'conflict', recoverable: true })
  assert.deepEqual(resolveWorldsPersistenceIndicator('error', 'invalid_response'), { status: 'error', recoverable: false })
  assert.deepEqual(resolveWorldsPersistenceIndicator('ready', null), { status: 'saved', recoverable: false })
})

test('tree mutations map move, effective lock, hide, cascade delete and duplicate through canonical commands', () => {
  const renderable: WorldRenderableComponent = {
    id: 'component:renderable', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true,
    castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
  }
  const model = snapshot([
    entity('entity:locked', null, { locked: true }),
    entity('entity:locked-child', 'entity:locked', { components: [renderable] }),
    entity('entity:target'),
  ])

  assert.throws(() => buildWorldTreeMutationCommands(model, 'scene:one', {
    type: 'move', entityIds: ['entity:locked-child'], parentId: 'entity:target',
  }), /locked/i)
  assert.deepEqual(buildWorldTreeMutationCommands(model, 'scene:one', {
    type: 'set-visible', entityIds: ['entity:locked-child'], visible: false, allowLocked: true,
  })[0], { type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:locked-child', componentId: 'component:renderable', component: { ...renderable, visible: false } })
  assert.deepEqual(buildWorldTreeMutationCommands(model, 'scene:one', {
    type: 'delete', entityIds: ['entity:target'], allowLocked: true,
  }), [{ type: 'remove-entity', sceneId: 'scene:one', entityId: 'entity:target', cascade: true }])
  assert.equal(buildWorldTreeMutationCommands(model, 'scene:one', {
    type: 'duplicate', entityIds: ['entity:target'], identitiesSeed: 'duplicate-test', allowLocked: true,
  })[0]?.type, 'add-entity')
})

test('numeric inspector commits validate, snap and revert without leaking invalid drafts', () => {
  assert.deepEqual(parseWorldInspectorNumber('1.25', { min: 0, max: 2 }), { success: true, value: 1.25 })
  assert.equal(parseWorldInspectorNumber('Infinity', {}).success, false)
  assert.equal(parseWorldInspectorNumber('-1', { min: 0 }).success, false)
  assert.equal(snapWorldInspectorValue(1.24, { enabled: true, increment: 0.5 }), 1)
  assert.deepEqual(reduceWorldsNumericDraft({ draft: '3', source: '2', error: null }, { type: 'escape' }), { draft: '2', source: '2', error: null, commit: null })
  const committed = reduceWorldsNumericDraft({ draft: '3', source: '2', error: null }, { type: 'commit', bounds: { min: 0, max: 4 } })
  assert.equal(committed.commit, 3)
})

test('multi-transform builder emits one command per selected entity for one atomic batch', () => {
  const model = snapshot([entity('entity:a'), entity('entity:b')])
  const commands = buildPatchEntityTransformsCommands(model, 'scene:one', [
    { entityId: 'entity:b', transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { entityId: 'entity:a', transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ])
  assert.equal(commands.length, 2)
  assert.deepEqual(commands.map((command) => command.entityId), ['entity:a', 'entity:b'])
})

test('registry-driven component replacement exposes conditional PBR camera and light fields', () => {
  const renderable: WorldRenderableComponent = {
    id: 'component:renderable', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true,
    castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
  }
  const replaced = buildInspectorComponentReplacement(renderable, 'material.metallic', 0.7)
  assert.equal(replaced.type, 'renderable')
  if (replaced.type === 'renderable') assert.equal(replaced.material.metallic, 0.7)

  const camera = { id: 'component:camera', type: 'camera' as const, enabled: true, projection: 'perspective' as const, primary: false, near: 0.1, far: 100, fieldOfView: 60 }
  assert.equal(getVisibleWorldInspectorFields(camera).some((field) => field.property === 'fieldOfView'), true)
  assert.equal(getVisibleWorldInspectorFields(camera).some((field) => field.property === 'orthographicSize'), false)
  const ortho = buildInspectorComponentReplacement(camera, 'projection', 'orthographic')
  assert.equal(ortho.type, 'camera')
  if (ortho.type === 'camera') {
    assert.equal(ortho.projection, 'orthographic')
    assert.equal(getVisibleWorldInspectorFields(ortho).some((field) => field.property === 'orthographicSize'), true)
  }

  const light = { id: 'component:light', type: 'light' as const, enabled: true, lightKind: 'point' as const, color: '#ffffff' as const, intensity: 1, range: 10, castShadow: true }
  assert.equal(getVisibleWorldInspectorFields(light).some((field) => field.property === 'range'), true)
  assert.equal(getVisibleWorldInspectorFields(light).some((field) => field.property === 'angle'), false)
})
