import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { applyWorldCommandBatch, type WorldCommand, type WorldCommandBatchV1 } from '../core/worldCommands.ts'
import { cloneWorldProjectSnapshot, validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { createWorldEditorController, type WorldEditorController } from '../editor/worldEditorController.ts'
import { createWorldUiTransactionId } from '../editor/useWorldEditorController.ts'
import { createWorldEditorTransformAdmission, type WorldEditorTransformAdmission, type WorldEditorTransformGesture } from '../editor/worldEditorTransformAdmission.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const projectKey = `world-${'a'.repeat(32)}`
const projectRoot = path.resolve(import.meta.dirname, '../../../..')

type Host = { type: string; props: Record<string, any>; children: Host[] }

test('mounted Inspector contextual gizmo tools retain mode-off choices, short labels and ineligible selection guards', async () => {
  const Inspector = await loadWorldsInspector(), host = mounted(), snapshot = createValidWorldSnapshot()
  const entity = snapshot.scenes[0].entities[0], modes: unknown[] = [], bases: string[] = []
  let mode: 'translate' | 'rotate' | 'scale' | null = 'translate'
  let baseScene = false
  const render = (extra = {}) => host.render(React.createElement(Inspector, {
    projectKey, snapshot, scene: snapshot.scenes[0], selectedEntityIds: [entity.id], activeEntityId: entity.id,
    snapEnabled: false, snapIncrement: 0.5, onSnap() {}, onCommands() {}, onError() {},
    viewportTools: { entityId: entity.id, mode, baseScene, disabled: false,
      onModeChange(value: typeof mode) { mode = value; modes.push(value) }, onToggleBaseSceneItem(id: string) { baseScene = !baseScene; bases.push(id) } }, ...extra,
  }))
  try {
    render()
    for (const [label, expected] of [['Move selected asset', null], ['Rotate selected asset', 'rotate'], ['Scale selected asset', 'scale'], ['Move selected asset', 'translate']] as const) {
      click(host, label); render(); assert.equal(mode, expected)
      assert.equal(requireButton(host, label).props['aria-pressed'], expected !== null)
      for (const [name, value] of [['Move', 'translate'], ['Rotate', 'rotate'], ['Scale', 'scale']]) {
        const button = requireButton(host, `${name} selected asset`)
        assert.equal(button.props['aria-pressed'], mode === value); assert.equal(text(button), name)
        assert.ok(button.props['aria-describedby'], 'The actual Tooltip must describe each native button')
      }
    }
    assert.deepEqual(modes, [null, 'rotate', 'scale', 'translate'])
    click(host, 'Set selected asset as base world'); assert.deepEqual(bases, [entity.id])
    render(); assert.equal(requireButton(host, 'Unset selected asset as base world').props['aria-pressed'], true)
    assert.equal(requireButton(host, 'Move selected asset').props.className.includes('worlds-authoring-action'), true)
    const position = requireNode(host, (node) => node.type === 'fieldset' && !!find(node, (child) => child.type === 'legend' && text(child).includes('Position')), 'Position fieldset')
    const numeric = find(position, (node) => node.type === 'input')!
    assert.ok(numeric)
    let prevented = false
    numeric.props.onKeyDown({ key: 'ArrowUp', preventDefault() { prevented = true } })
    assert.equal(prevented, false); assert.deepEqual(modes, [null, 'rotate', 'scale', 'translate'])
    render({ transformPending: true }); assert.equal(requireButton(host, 'Move selected asset').props.disabled, true)
    assert.equal(requireButton(host, 'Unset selected asset as base world').props.disabled, true)
    render({ selectedEntityIds: [], activeEntityId: null }); assert.equal(find(host.container, (node) => node.props['aria-label'] === 'Move selected asset'), undefined)
    entity.components = []; render(); assert.equal(find(host.container, (node) => node.props['aria-label'] === 'Move selected asset'), undefined)
  } finally { host.render(null) }
})

test('mounted Inspector primitive collider callbacks apply canonical commands, preserve session deltas, and undo/redo', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = modelFreeSnapshot()
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector)
  assert.equal(text(host.container).includes('Add a GLB, GLTF, or PLY mesh asset first.'), false)

  click(host, 'Add Sphere Collider')
  await settle(host)
  const afterSphere = currentSnapshot(controller)
  assert.equal(text(host.container).includes('Add a GLB, GLTF, or PLY mesh asset first.'), false)
  const sphere = afterSphere.scenes[0].entities[0].components.at(-1)
  assert.deepEqual(sphere, {
    id: sphere?.id,
    type: 'collider',
    enabled: true,
    purpose: 'simulation',
    shape: 'sphere',
    radius: 0.5,
    sensor: false,
    friction: 0.5,
    restitution: 0,
    collisionLayer: 1,
    collisionMask: 0xffff,
  })
  assert.equal(afterSphere.project.revision, initial.project.revision + 1)
  assert.equal(controller.getState().canUndo, true)
  assert.equal(gateway.applyCalls.at(-1)?.commands.length, 1)

  click(host, 'Add Capsule Collider')
  await settle(host)
  const afterCapsule = currentSnapshot(controller)
  const capsule = afterCapsule.scenes[0].entities[0].components.at(-1)
  assert.equal(capsule?.type, 'collider')
  if (capsule?.type === 'collider') {
    assert.equal(capsule.shape, 'capsule')
    assert.equal(capsule.radius, 0.35)
    assert.equal(capsule.halfHeight, 0.55)
  }

  assert.equal((await controller.undo()).ok, true)
  assert.equal(currentSnapshot(controller).scenes[0].entities[0].components.length, afterSphere.scenes[0].entities[0].components.length)
  assert.equal(controller.getState().canRedo, true)
  assert.equal((await controller.redo()).ok, true)
  assert.deepEqual(currentSnapshot(controller), gateway.snapshot)
})

test('mounted Inspector authors a compact portal behavior through command batches with undoable revisions', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  initial.project.resources.push({ id: 'resource:beep', type: 'audio', name: 'Beep', workspacePath: 'Audio/beep.wav', format: 'wav' })
  initial.scenes[0].entities[0]!.tags = ['player']
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector)

  const edit = async (label: string) => {
    const before = currentSnapshot(controller).project.revision
    click(host, label)
    await settle(host)
    const batch = gateway.applyCalls.at(-1)
    assert.equal(batch?.schema, WORLD_COMMAND_BATCH_SCHEMA)
    assert.equal(batch?.origin, 'ui')
    assert.equal(batch?.baseRevision, before)
    assert.equal(currentSnapshot(controller).project.revision, before + 1)
  }

  await edit('Add Trigger')
  await edit('Add Audio Listener')
  await edit('Add Audio Source')
  await edit('Add Behavior')
  await edit('Add rule')

  const behaviorSection = requireNode(host, (node) => node.type === 'section' && text(node).includes('Rule 1'), 'Behavior section')
  const beforeEvent = currentSnapshot(controller).project.revision
  changeSelect(selectByLabelWithin(behaviorSection, 'Event'), 'trigger-enter')
  await settle(host)
  assert.equal(gateway.applyCalls.at(-1)?.baseRevision, beforeEvent)

  const beforeAudioAction = currentSnapshot(controller).project.revision
  click(host, 'Add action')
  await settle(host)
  assert.equal(gateway.applyCalls.at(-1)?.baseRevision, beforeAudioAction)
  changeSelect(selectByLabelWithin(requireNode(host, (node) => node.type === 'section' && text(node).includes('Rule 1'), 'Behavior section after audio action'), 'Action'), 'play-audio')
  await settle(host)

  const beforeSceneAction = currentSnapshot(controller).project.revision
  click(host, 'Add action')
  await settle(host)
  assert.equal(gateway.applyCalls.at(-1)?.baseRevision, beforeSceneAction)
  const actionSelects = controlsByLabelWithin(
    requireNode(host, (node) => node.type === 'section' && text(node).includes('Rule 1'), 'Behavior section after scene action'),
    'Action',
  )
  changeSelect(actionSelects.at(-1)!, 'change-scene')
  await settle(host)

  const snapshot = currentSnapshot(controller)
  const behavior = snapshot.scenes[0].entities[0]!.components.find((component) => component.type === 'behavior')
  assert.equal(behavior?.type, 'behavior')
  if (behavior?.type !== 'behavior') return
  assert.deepEqual(behavior.bindings[0]?.actions.map((action) => action.type), ['play-audio', 'change-scene'])
  assert.equal(behavior.bindings[0]?.event.type, 'trigger-enter')
  assert.equal(behavior.bindings[0]?.actions.find((action) => action.type === 'change-scene')?.sceneId, 'scene:two')
  assert.equal(text(host.container).includes('script'), false)
  assert.equal(find(host.container, (node) => node.type === 'textarea'), undefined)
  assert.equal(requireButton(host, 'Add rule').props.disabled, false)
  assert.ok(text(requireButton(host, 'Add rule')).length <= 12)
  assert.equal((await controller.undo()).ok, true)
  assert.deepEqual(
    currentSnapshot(controller).scenes[0].entities[0]!.components.find((component) => component.type === 'behavior')?.bindings[0]?.actions.map((action) => action.type),
    ['play-audio', 'set-visibility'],
  )
  assert.equal((await controller.redo()).ok, true)
  assert.deepEqual(
    currentSnapshot(controller).scenes[0].entities[0]!.components.find((component) => component.type === 'behavior')?.bindings[0]?.actions.map((action) => action.type),
    ['play-audio', 'change-scene'],
  )
})

test('mounted Inspector edits existing Animation player controls through canonical commands and undo/redo', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const errors: string[] = []
  const initial = animationPlayerSnapshot()
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector, { errors })
  assert.equal(text(host.container).includes('Animation player'), true)
  assert.equal(text(host.container).includes('Walk'), true)
  assert.equal(find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Add Animation Player'), undefined)

  changeCheckbox(selectByLabelInSection(host, 'Animation player', 'Autoplay'), true)
  await settle(host)
  let player = getAnimationPlayer(currentSnapshot(controller))
  assert.equal(player.autoplay, true)
  assert.equal(player.loop, true)
  assert.equal(player.resourceId, 'resource:walk')
  assert.equal(currentSnapshot(controller).project.revision, initial.project.revision + 1)
  assert.equal(gateway.applyCalls.at(-1)?.commands[0]?.type, 'replace-component')

  changeCheckbox(selectByLabelInSection(host, 'Animation player', 'Loop'), false)
  await settle(host)
  player = getAnimationPlayer(currentSnapshot(controller))
  assert.equal(player.loop, false)
  assert.equal(player.resourceId, 'resource:walk')

  commitNumberInSection(host, 'Animation player', 'Speed', '1.5')
  await settle(host)
  player = getAnimationPlayer(currentSnapshot(controller))
  assert.equal(player.speed, 1.5)
  assert.equal(player.resourceId, 'resource:walk')

  commitNumberInSection(host, 'Animation player', 'Speed', '-0.5')
  await settle(host)
  player = getAnimationPlayer(currentSnapshot(controller))
  assert.equal(player.speed, -0.5)
  assert.equal(player.resourceId, 'resource:walk')

  assert.equal((await controller.undo()).ok, true)
  assert.equal(getAnimationPlayer(currentSnapshot(controller)).speed, 1.5)
  assert.equal(controller.getState().canRedo, true)
  assert.equal((await controller.redo()).ok, true)
  assert.equal(getAnimationPlayer(currentSnapshot(controller)).speed, -0.5)

  const beforeZero = currentSnapshot(controller).project.revision
  commitNumberInSection(host, 'Animation player', 'Speed', '0')
  await settle(host)
  assert.equal(currentSnapshot(controller).project.revision, beforeZero)
  assert.equal(errors.at(-1), 'Animation player properties are invalid.')
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '-0.5')

  commitNumberInSection(host, 'Animation player', 'Speed', 'Infinity')
  await settle(host)
  assert.equal(currentSnapshot(controller).project.revision, beforeZero)
  assert.equal(text(host.container).includes('Use a finite number.'), true)

  const stale = await controller.dispatchCommands({
    transactionId: createWorldUiTransactionId('stale-animation'),
    origin: 'ui',
    commands: [{
      type: 'replace-component',
      sceneId: 'scene:one',
      entityId: 'entity:hero',
      componentId: 'component:animation',
      component: { ...getAnimationPlayer(currentSnapshot(controller)), speed: 2 },
    }],
  }, {
    projectKey,
    projectId: currentSnapshot(controller).project.projectId,
    baseRevision: beforeZero - 1,
    activeSceneId: 'scene:one',
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')

  const beforeBehavior = currentSnapshot(controller)
  const referenced = await controller.dispatchCommands({
    transactionId: createWorldUiTransactionId('reference-animation'),
    origin: 'ui',
    commands: [{
      type: 'add-component',
      sceneId: 'scene:one',
      entityId: 'entity:hero',
      component: {
        id: 'component:behavior-animation',
        type: 'behavior',
        enabled: true,
        bindings: [{
          id: 'binding:animation',
          event: { type: 'start' },
          actions: [{ type: 'play-animation', entityId: 'entity:hero', componentId: 'component:animation' }],
        }],
      },
    }],
  }, {
    projectKey,
    projectId: beforeBehavior.project.projectId,
    baseRevision: beforeBehavior.project.revision,
    activeSceneId: 'scene:one',
  })
  assert.equal(referenced.ok, true)
  const beforeReferencedRemove = currentSnapshot(controller).project.revision
  click(host, 'Remove Animation player')
  await settle(host)
  assert.equal(currentSnapshot(controller).project.revision, beforeReferencedRemove)
  assert.equal(getAnimationPlayer(currentSnapshot(controller)).resourceId, 'resource:walk')
  assert.match(errors.at(-1) ?? '', /referenced/)
  assert.equal((await controller.undo()).ok, true)

  click(host, 'Remove Animation player')
  await settle(host)
  assert.equal(findAnimationPlayer(currentSnapshot(controller)), null)
  assert.equal((await controller.undo()).ok, true)
  assert.equal(getAnimationPlayer(currentSnapshot(controller)).resourceId, 'resource:walk')

  const locked = animationPlayerSnapshot()
  locked.scenes[0].entities.unshift({ ...structuredClone(locked.scenes[0].entities[0]), id: 'entity:parent', name: 'Parent', parentId: null, locked: true, components: [] })
  locked.scenes[0].entities[1]!.parentId = 'entity:parent'
  gateway.replaceSnapshot(locked)
  assert.equal((await controller.refresh()).ok, true)
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Enabled').props.disabled, true)
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Autoplay').props.disabled, true)
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Loop').props.disabled, true)
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.disabled, true)
  assert.equal(requireButton(host, 'Remove Animation player').props.disabled, true)
  assert.equal(getAnimationPlayer(currentSnapshot(controller)).resourceId, 'resource:walk')
})

test('mounted Inspector body presets reuse authored sphere and capsule colliders without ghost boxes', async () => {
  const WorldsInspector = await loadWorldsInspector()
  for (const [colliderLabel, bodyLabel, expectedBodyType] of [
    ['Add Sphere Collider', 'Add Dynamic Body', 'dynamic'],
    ['Add Capsule Collider', 'Add Fixed Body', 'fixed'],
  ] as const) {
    const initial = modelFreeSnapshot()
    const gateway = createGateway(initial)
    const controller = createWorldEditorController(gateway)
    assert.equal((await controller.openProject(projectKey)).ok, true)
    const host = mountInspector(controller, WorldsInspector)

    click(host, colliderLabel)
    await settle(host)
    const afterCollider = currentSnapshot(controller)
    const authoredCollider = afterCollider.scenes[0].entities[0].components.at(-1)
    assert.equal(authoredCollider?.type, 'collider')

    click(host, bodyLabel)
    await settle(host)
    const afterBody = currentSnapshot(controller)
    const components = afterBody.scenes[0].entities[0].components
    assert.equal(afterBody.project.revision, afterCollider.project.revision + 1)
    assert.equal(gateway.applyCalls.at(-1)?.commands.length, 1)
    assert.deepEqual(components.slice(0, -1), afterCollider.scenes[0].entities[0].components)
    assert.equal(components.some((component) => component.type === 'collider' && component.shape === 'box'), false)
    const rigidBody = components.at(-1)
    assert.equal(rigidBody?.type, 'rigid-body')
    if (rigidBody?.type === 'rigid-body') assert.equal(rigidBody.bodyType, expectedBodyType)

    assert.equal((await controller.undo()).ok, true)
    assert.deepEqual(currentSnapshot(controller).scenes[0].entities[0].components, afterCollider.scenes[0].entities[0].components)
    assert.equal(currentSnapshot(controller).scenes[0].entities[0].components.at(-1)?.type, 'collider')
    assert.equal((await controller.redo()).ok, true)
    assert.deepEqual(currentSnapshot(controller).scenes[0].entities[0].components, afterBody.scenes[0].entities[0].components)
  }
})

test('mounted Inspector advanced collider authoring uses real controller commands, source selection, conflicts, undo and entity replacement sync', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  initial.project.resources = [
    { id: 'resource:first', type: 'model', name: 'First mesh', workspacePath: 'Assets/first.glb', format: 'glb' },
    { id: 'resource:selected', type: 'model', name: 'Selected mesh', workspacePath: 'Assets/selected.glb', format: 'glb' },
    { id: 'resource:points', type: 'model', name: 'Points', workspacePath: 'Assets/points.ply', format: 'ply-points' },
  ]
  const renderable = initial.scenes[0].entities[0].components.find((component) => component.type === 'renderable')
  assert.ok(renderable?.type === 'renderable')
  renderable.resourceId = 'resource:selected'
  renderable.enabled = false
  renderable.visible = false
  const errors: string[] = []
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector, { errors })
  await settle(host)

  click(host, 'Add Convex Hull')
  await settle(host)
  let snapshot = currentSnapshot(controller)
  let collider = snapshot.scenes[0].entities[0].components.at(-1)
  assert.equal(collider?.type, 'collider')
  if (collider?.type === 'collider') {
    assert.equal(collider.shape, 'convex')
    assert.equal(collider.resourceId, 'resource:selected')
    assert.equal(Object.hasOwn(collider, 'workspacePath'), false)
    assert.equal(Object.hasOwn(collider, 'vertices'), false)
  }
  assert.equal(gateway.applyCalls.at(-1)?.origin, 'ui')
  assert.equal(gateway.applyCalls.at(-1)?.commands[0]?.type, 'add-component')

  const sourceSelect = selectByLabelInSection(host, 'Add component', 'Mesh source')
  changeSelect(sourceSelect, 'resource:first')
  await settle(host)
  click(host, 'Add Static Mesh')
  await settle(host)
  snapshot = currentSnapshot(controller)
  collider = snapshot.scenes[0].entities[0].components.at(-1)
  assert.equal(collider?.type, 'collider')
  if (collider?.type === 'collider') {
    assert.equal(collider.shape, 'mesh')
    assert.equal(collider.resourceId, 'resource:first')
  }

  assert.equal((await controller.undo()).ok, true)
  assert.equal(currentSnapshot(controller).scenes[0].entities[0].components.some((component) => component.type === 'collider' && component.shape === 'mesh'), false)
  assert.equal((await controller.redo()).ok, true)
  assert.equal(currentSnapshot(controller).scenes[0].entities[0].components.some((component) => component.type === 'collider' && component.shape === 'mesh'), true)

  snapshot = currentSnapshot(controller)
  gateway.replaceSnapshot({
    ...structuredClone(snapshot),
    scenes: [{
      ...structuredClone(snapshot.scenes[0]),
      entities: [{
        ...structuredClone(snapshot.scenes[0].entities[0]),
        id: 'entity:empty',
        name: 'Empty',
        components: [],
      }],
    }, structuredClone(snapshot.scenes[1])],
  })
  assert.equal((await controller.refresh()).ok, true)
  const emptyHost = mountInspector(controller, WorldsInspector, { errors, selectedEntityId: 'entity:empty' })
  await settle(emptyHost)
  assert.equal(requireButton(emptyHost, 'Add Convex Hull').props.disabled, true)
  changeSelect(selectByLabelInSection(emptyHost, 'Add component', 'Mesh source'), 'resource:first')
  await settle(emptyHost)
  click(emptyHost, 'Add Convex Hull')
  await settle(emptyHost)
  const emptyCollider = currentSnapshot(controller).scenes[0].entities[0].components.at(-1)
  assert.equal(emptyCollider?.type, 'collider')
  if (emptyCollider?.type === 'collider') {
    assert.equal(emptyCollider.shape, 'convex')
    if (emptyCollider.shape === 'convex') assert.equal(emptyCollider.resourceId, 'resource:first')
  }
})

test('mounted Inspector primitive to advanced conversion uses explicit mesh source and preserves authored advanced source', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  initial.project.resources = [
    { id: 'resource:first', type: 'model', name: 'First mesh', workspacePath: 'Assets/first.glb', format: 'glb' },
    { id: 'resource:renderable', type: 'model', name: 'Renderable mesh', workspacePath: 'Assets/renderable.glb', format: 'glb' },
    { id: 'resource:selected', type: 'model', name: 'Selected mesh', workspacePath: 'Assets/selected.glb', format: 'glb' },
  ]
  initial.scenes[0].entities[0].components = [
    { id: 'component:renderable', type: 'renderable', enabled: true, resourceId: 'resource:renderable', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
    { id: 'component:box', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
  ]
  const errors: string[] = []
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector, { errors })
  await settle(host)

  changeSelect(selectByLabelInSection(host, 'Add component', 'Mesh source'), 'resource:selected')
  await settle(host)
  changeSelect(selectByLabelInSection(host, 'Collider', 'Shape'), 'convex')
  await settle(host)
  assert.deepEqual(errors, [])
  let collider = currentSnapshot(controller).scenes[0].entities[0].components.find((component) => component.id === 'component:box')
  assert.equal(collider?.type, 'collider')
  if (collider?.type === 'collider') {
    assert.equal(collider.shape, 'convex')
    if (collider.shape === 'convex') assert.equal(collider.resourceId, 'resource:selected')
  }

  changeSelect(selectByLabelInSection(host, 'Collider', 'Shape'), 'mesh')
  await settle(host)
  collider = currentSnapshot(controller).scenes[0].entities[0].components.find((component) => component.id === 'component:box')
  assert.equal(collider?.type, 'collider')
  if (collider?.type === 'collider') {
    assert.equal(collider.shape, 'mesh')
    if (collider.shape === 'mesh') assert.equal(collider.resourceId, 'resource:selected')
  }
})

test('mounted Inspector rejects cleared or stale explicit advanced conversion sources without mutation', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  initial.project.resources = [
    { id: 'resource:first', type: 'model', name: 'First mesh', workspacePath: 'Assets/first.glb', format: 'glb' },
    { id: 'resource:points', type: 'model', name: 'Points', workspacePath: 'Assets/points.ply', format: 'ply-points' },
  ]
  initial.scenes[0].entities[0].components = [{ id: 'component:box', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff }]
  const errors: string[] = []
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector, { errors })
  await settle(host)
  const before = structuredClone(currentSnapshot(controller))

  changeSelect(selectByLabelInSection(host, 'Add component', 'Mesh source'), '')
  await settle(host)
  changeSelect(selectByLabelInSection(host, 'Collider', 'Shape'), 'convex')
  await settle(host)
  assert.deepEqual(currentSnapshot(controller), before)
  assert.match(errors.at(-1) ?? '', /mesh source/i)

  gateway.replaceSnapshot({
    ...structuredClone(before),
    project: {
      ...structuredClone(before.project),
      resources: [{ id: 'resource:points', type: 'model', name: 'Points', workspacePath: 'Assets/points.ply', format: 'ply-points' }],
    },
  })
  assert.equal((await controller.refresh()).ok, true)
  const refreshed = mountInspector(controller, WorldsInspector, { errors })
  await settle(refreshed)
  assert.equal(requireButton(refreshed, 'Add Convex Hull').props.disabled, true)
  changeSelect(selectByLabelInSection(refreshed, 'Collider', 'Shape'), 'mesh')
  await settle(refreshed)
  assert.equal(currentSnapshot(controller).scenes[0].entities[0].components[0]?.type, 'collider')
  assert.match(errors.at(-1) ?? '', /mesh source/i)
})

test('mounted Inspector scopes explicit mesh source by canonical scene and entity tuple instead of colon-concatenated text', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  initial.project.resources = [
    { id: 'resource:first', type: 'model', name: 'First mesh', workspacePath: 'Assets/first.glb', format: 'glb' },
  ]
  initial.project.scenes = [
    { id: 'scene:a', name: 'Scene A', documentPath: 'Worlds/scene-a.world-scene.json' },
    { id: 'scene:a:entity:b', name: 'Scene B', documentPath: 'Worlds/scene-b.world-scene.json' },
  ]
  initial.project.startSceneId = 'scene:a'
  initial.scenes = [
    {
      ...structuredClone(initial.scenes[0]),
      sceneId: 'scene:a',
      name: 'Scene A',
      entities: [{ ...structuredClone(initial.scenes[0].entities[0]), id: 'entity:b:entity:c', name: 'First entity', components: [] }],
    },
    {
      ...structuredClone(initial.scenes[1]),
      sceneId: 'scene:a:entity:b',
      name: 'Scene B',
      entities: [{ ...structuredClone(initial.scenes[0].entities[0]), id: 'entity:c', name: 'Second entity', components: [] }],
    },
  ]
  const validation = validateWorldProjectSnapshot(initial)
  assert.equal(validation.success, true, validation.success ? undefined : JSON.stringify(validation.issues))
  assert.equal(`${projectKey}:${initial.scenes[0].sceneId}:${initial.scenes[0].entities[0]!.id}`, `${projectKey}:${initial.scenes[1].sceneId}:${initial.scenes[1].entities[0]!.id}`)
  const errors: string[] = []
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  let selectedEntityId = 'entity:b:entity:c'
  const host = mountInspector(controller, WorldsInspector, { errors, selectedEntityId: () => selectedEntityId })
  await settle(host)

  changeSelect(selectByLabelInSection(host, 'Add component', 'Mesh source'), 'resource:first')
  await settle(host)
  assert.equal(requireButton(host, 'Add Convex Hull').props.disabled, false)
  selectedEntityId = 'entity:c'
  assert.equal((await controller.setActiveScene('scene:a:entity:b')).ok, true)
  await settle(host)

  assert.equal(selectByLabelInSection(host, 'Add component', 'Mesh source').props.value, '')
  assert.equal(requireButton(host, 'Add Convex Hull').props.disabled, true)
})

test('mounted Inspector rejects static mesh body conflicts without mutating snapshot', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  initial.scenes[0].entities[0].components.push(
    { id: 'component:mesh', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:hero', sensor: true, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
  )
  const errors: string[] = []
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector, { errors })
  await settle(host)
  const before = structuredClone(currentSnapshot(controller))

  click(host, 'Add Dynamic Body')
  await settle(host)
  assert.deepEqual(currentSnapshot(controller), before)
  assert.match(errors.at(-1) ?? '', /fixed body/i)
})

test('mounted Inspector shape and primitive dimension callbacks reject stale, locked, guarded and invalid changes', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = createValidWorldSnapshot()
  const entity = initial.scenes[0].entities[0]
  entity.components.push(
    { id: 'component:collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.25, 0.5, 0.75], sensor: false, friction: 0.3, restitution: 0.2, collisionLayer: 5, collisionMask: 9 },
    { id: 'component:body', type: 'rigid-body', enabled: true, bodyType: 'kinematic-position', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: false },
    { id: 'component:character', type: 'character-controller', enabled: true, colliderComponentId: 'component:collider', moveActionId: 'input:move', speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45 },
  )
  initial.project.inputActions.push({ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [{ kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 }] })
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const host = mountInspector(controller, WorldsInspector)

  const shapeSelect = selectByLabelInSection(host, 'Collider', 'Shape')
  assert.equal(shapeSelect.props.disabled, false)
  changeSelect(shapeSelect, 'sphere')
  await settle(host)
  const sphere = currentSnapshot(controller).scenes[0].entities[0].components.find((component) => component.id === 'component:collider')
  assert.equal(sphere?.type, 'collider')
  if (sphere?.type === 'collider') {
    assert.equal(sphere.shape, 'sphere')
    assert.equal(sphere.radius, 0.75)
    assert.equal(sphere.enabled, true)
    assert.equal(sphere.sensor, false)
    assert.equal(sphere.friction, 0.3)
    assert.equal(sphere.restitution, 0.2)
    assert.equal(Object.hasOwn(sphere, 'halfExtents'), false)
  }
  assert.equal(selectByLabelInSection(host, 'Collider', 'Enabled').props.disabled, true)
  assert.equal(selectByLabelInSection(host, 'Collider', 'Sensor').props.disabled, true)

  const revisionBeforeInvalid = currentSnapshot(controller).project.revision
  commitNumber(host, 'Radius', '0')
  await settle(host)
  assert.equal(currentSnapshot(controller).project.revision, revisionBeforeInvalid)
  assert.equal(text(host.container).includes('Minimum 0.001.'), true)

  const staleCommands: WorldCommand[] = [{ type: 'add-component', sceneId: 'scene:one', entityId: 'entity:hero', component: { id: 'component:stale', type: 'collider', enabled: true, purpose: 'simulation', shape: 'sphere', radius: 1, sensor: false, friction: 0.5, restitution: 0 } }]
  const stale = await controller.dispatchCommands({ transactionId: createWorldUiTransactionId('stale'), origin: 'ui', commands: staleCommands }, {
    projectKey,
    projectId: currentSnapshot(controller).project.projectId,
    baseRevision: revisionBeforeInvalid - 1,
    activeSceneId: 'scene:one',
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')

  const lockedSnapshot = modelFreeSnapshot()
  lockedSnapshot.scenes[0].entities[0].locked = true
  gateway.replaceSnapshot(lockedSnapshot)
  assert.equal((await controller.refresh()).ok, true)
  assert.equal(requireButton(host, 'Add Sphere Collider').props.disabled, true)
  assert.equal(currentSnapshot(controller).scenes[0].entities[0].components.length, 0)

  lockedSnapshot.scenes[0].entities[0].locked = false
  lockedSnapshot.scenes[0].entities.unshift({ ...structuredClone(lockedSnapshot.scenes[0].entities[0]), id: 'entity:parent', name: 'Parent', parentId: null, locked: true, components: [] })
  lockedSnapshot.scenes[0].entities[1]!.parentId = 'entity:parent'
  gateway.replaceSnapshot(lockedSnapshot)
  assert.equal((await controller.refresh()).ok, true)
  assert.equal(requireButton(host, 'Add Capsule Collider').props.disabled, true)
  assert.equal(currentSnapshot(controller).scenes[0].entities.find((candidate) => candidate.id === 'entity:hero')?.components.length, 0)
})

test('mounted Inspector rejected transform commit reconciles unchanged canonical numeric draft', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const initial = modelFreeSnapshot()
  const gateway = createGateway(initial)
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  let dispatches = 0
  const host = mountInspector(controller, WorldsInspector, {
    onCommands: async () => {
      dispatches += 1
      return false
    },
  })

  const input = selectByLabelInSection(host, 'Transform', 'X')
  assert.equal(input.props.value, '0')
  input.props.onChange({ currentTarget: { value: '4' } })
  host.flush()
  input.props.onBlur()
  await settle(host)

  assert.equal(dispatches, 1)
  assert.equal(currentSnapshot(controller).scenes[0].entities[0].transform.position[0], 0)
  assert.equal(selectByLabelInSection(host, 'Transform', 'X').props.value, '0')
})

test('mounted Inspector component numeric rejection waits for the real controller and preserves newer drafts', async () => {
  const WorldsInspector = await loadWorldsInspector()
  for (const { newerDraft, fail } of [{ newerDraft: null, fail: true }, { newerDraft: '2', fail: true }, { newerDraft: '2', fail: false }]) {
    const gateway = createGateway(animationPlayerSnapshot())
    const controller = createWorldEditorController(gateway)
    assert.equal((await controller.openProject(projectKey)).ok, true)
    const errors: string[] = []
    const host = mountInspector(controller, WorldsInspector, { errors })
    const before = structuredClone(controller.getState().session)
    let release!: () => void
    gateway.applyGate = () => new Promise<void>((resolve) => { release = resolve })
    gateway.failNextApply = fail
    commitNumberInSection(host, 'Animation player', 'Speed', '1.5')
    await waitFor(host, () => !!release)
    assert.equal(controller.getState().lifecycle, 'loading')
    assert.deepEqual(controller.getState().session, before)
    assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '1.5')
    if (newerDraft) commitNumberInSection(host, 'Animation player', 'Speed', newerDraft)
    else selectByLabelInSection(host, 'Animation player', 'Speed').props.onBlur()
    await settle(host)
    assert.equal(host.dispatches, 1, 'The same numeric field must not dispatch again before settlement.')
    release()
    await waitFor(host, () => controller.getState().lifecycle === (fail ? 'error' : 'ready'))
    await settle(host)
    if (fail) {
      assert.deepEqual(controller.getState().session, before)
      assert.equal(errors.at(-1), 'Deferred component write failed.')
    } else assert.equal(getAnimationPlayer(currentSnapshot(controller)).speed, 1.5)
    assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, newerDraft ?? '1')
    gateway.applyGate = null
    commitNumberInSection(host, 'Animation player', 'Speed', '2')
    await waitFor(host, () => getAnimationPlayer(currentSnapshot(controller)).speed === 2)
    assert.equal(controller.getState().session!.undoStack.length, before!.undoStack.length + (fail ? 1 : 2))
    assert.equal((await controller.undo()).ok, true)
    assert.equal(getAnimationPlayer(currentSnapshot(controller)).speed, fail ? 1 : 1.5)
    host.render(null)
  }
})

test('mounted Inspector numeric fields reset full owner identity and ignore an old owner rejection', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const gateway = createGateway(animationPlayerSnapshot())
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  let rejectOld!: (value: boolean) => void
  let calls = 0
  const host = mountInspector(controller, WorldsInspector, { onCommands: () => {
    calls += 1
    return calls === 1 ? new Promise<boolean>((resolve) => { rejectOld = resolve }) : false
  } })
  commitNumberInSection(host, 'Animation player', 'Speed', '1.5')
  const replacement = animationPlayerSnapshot()
  replacement.project.projectId = 'project:replacement'
  for (const scene of replacement.scenes) scene.projectId = replacement.project.projectId
  gateway.replaceSnapshot(replacement)
  assert.equal((await controller.refresh()).ok, true)
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '1')
  const input = selectByLabelInSection(host, 'Animation player', 'Speed')
  input.props.onChange({ currentTarget: { value: '3' } })
  host.flush()
  rejectOld(false)
  await settle(host)
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '3')
  selectByLabelInSection(host, 'Animation player', 'Speed').props.onBlur()
  await settle(host)
  assert.equal(calls, 2, 'An old owner pending fence must not suppress the new owner commit.')
  assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '1')
  host.render(null)
})

test('concurrent mounted Inspector rejection reads committed canonical value, not suspended speculative props', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const host = mounted(1)
  const committed = animationPlayerSnapshot()
  const speculative = animationPlayerSnapshot()
  let speculativeReads = 0
  Object.defineProperty(getAnimationPlayer(speculative), 'speed', { enumerable: true, get() { speculativeReads += 1; return 99 } })
  let rejectPending!: (accepted: boolean) => void
  let committedCanonical = 0
  let suspendedRenders = 0
  const never = new Promise<void>(() => {})
  function Sibling({ suspend }: { suspend: boolean }) { if (suspend) { suspendedRenders += 1; throw never } return null }
  function Screen({ snapshot, suspend, canonical }: { snapshot: WorldProjectSnapshotV1; suspend: boolean; canonical: number }) {
    React.useLayoutEffect(() => { committedCanonical = canonical }, [canonical])
    return React.createElement(React.Suspense, { fallback: React.createElement('aside', null, 'Loading fixture') },
      React.createElement(WorldsInspector, { projectKey, snapshot, scene: snapshot.scenes[0], selectedEntityIds: ['entity:hero'], activeEntityId: 'entity:hero', snapEnabled: false, snapIncrement: 0.5, onSnap() {}, onError() {}, onCommands: () => new Promise<boolean>((resolve) => { rejectPending = resolve }) }),
      React.createElement(Sibling, { suspend }))
  }
  try {
    host.render(React.createElement(Screen, { snapshot: committed, suspend: false, canonical: 1 }))
    commitNumberInSection(host, 'Animation player', 'Speed', '1.5')
    assert.equal(typeof rejectPending, 'function')
    host.transition(React.createElement(Screen, { snapshot: speculative, suspend: true, canonical: 99 }))
    await waitFor(host, () => suspendedRenders > 0)
    assert.ok(speculativeReads > 0, 'Production Inspector must actually read the speculative numeric prop before sibling suspension.')
    assert.equal(committedCanonical, 1, 'The speculative screen must not commit.')
    assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '1.5')
    rejectPending(false)
    await settle(host)
    const actual = selectByLabelInSection(host, 'Animation player', 'Speed').props.value
    console.log(JSON.stringify({ committedCanonical, speculativeReads, suspendedRenders, beforeRejection: '1.5', afterRejection: actual, expectedAfterRejection: '1' }))
    assert.equal(actual, '1', 'Late rejection must use the committed canonical number, never speculative 99.')
  } finally { host.render(null) }
})

test('concurrent mounted Inspector publishes committed prop changes while preserving newer pending drafts', async () => {
  const WorldsInspector = await loadWorldsInspector()
  for (const accepted of [false, true]) {
    const host = mounted(1)
    let settlePending!: (value: boolean) => void
    let calls = 0
    const onCommands = () => ++calls === 1 ? new Promise<boolean>((resolve) => { settlePending = resolve }) : false
    const render = (snapshot: WorldProjectSnapshotV1) => host.render(React.createElement(WorldsInspector, { projectKey, snapshot, scene: snapshot.scenes[0], selectedEntityIds: ['entity:hero'], activeEntityId: 'entity:hero', snapEnabled: false, snapIncrement: 0.5, onSnap() {}, onError() {}, onCommands }))
    render(animationPlayerSnapshot())
    commitNumberInSection(host, 'Animation player', 'Speed', '1.5')
    const input = selectByLabelInSection(host, 'Animation player', 'Speed')
    input.props.onChange({ currentTarget: { value: '2' } })
    host.flush()
    const changed = animationPlayerSnapshot()
    getAnimationPlayer(changed).speed = 9
    render(changed)
    assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '2')
    settlePending(accepted)
    await settle(host)
    assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '2')
    selectByLabelInSection(host, 'Animation player', 'Speed').props.onBlur()
    await settle(host)
    assert.equal(calls, 2)
    assert.equal(selectByLabelInSection(host, 'Animation player', 'Speed').props.value, '9', 'A fresh rejected retry must read current committed canonical, even after the draft reset was guarded.')
    host.render(null)
  }
})

test('mounted Inspector Enter blur, Escape retry and unmount preserve numeric callback lifetimes', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const controller = createWorldEditorController(createGateway(animationPlayerSnapshot()))
  assert.equal((await controller.openProject(projectKey)).ok, true)
  let settlePending!: (value: boolean) => void
  let calls = 0
  const host = mountInspector(controller, WorldsInspector, { onCommands: () => ++calls === 1 ? new Promise<boolean>((resolve) => { settlePending = resolve }) : false })
  commitNumberInSection(host, 'Animation player', 'Speed', '1.5')
  const input = () => selectByLabelInSection(host, 'Animation player', 'Speed')
  input().props.onKeyDown({ key: 'Enter', currentTarget: { blur: () => input().props.onBlur() } })
  input().props.onBlur()
  assert.equal(calls, 1)
  input().props.onKeyDown({ key: 'Escape', preventDefault() {} })
  host.flush()
  assert.equal(input().props.value, '1')
  input().props.onChange({ currentTarget: { value: '2' } })
  host.flush()
  settlePending(false)
  await settle(host)
  assert.equal(input().props.value, '2')
  input().props.onBlur()
  await settle(host)
  assert.equal(calls, 2)
  assert.equal(input().props.value, '1')
  const unmounted = mountInspector(controller, WorldsInspector, { onCommands: () => new Promise<boolean>((resolve) => { settlePending = resolve }) })
  commitNumberInSection(unmounted, 'Animation player', 'Speed', '1.5')
  unmounted.render(null)
  settlePending(false)
  await settle(unmounted)
  assert.equal(unmounted.container.children.length, 0)
  host.render(null)
})

test('mounted Inspector invalid transform blur cancels admission and allows inspector and viewport admission afterwards', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const gateway = createGateway(modelFreeSnapshot())
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const admission = createMountedTransformAdmission(controller)
  const host = mountInspector(controller, WorldsInspector, { transformAdmission: admission.api })

  const input = selectByLabelInSection(host, 'Transform', 'X')
  input.props.onFocus()
  assert.equal(admission.activeId(), 'transform:inspector:1')
  input.props.onChange({ currentTarget: { value: 'abc' } })
  host.flush()
  input.props.onBlur()
  await settle(host)

  assert.equal(text(host.container).includes('Use a finite number.'), true)
  assert.equal(admission.activeId(), null)
  assert.notEqual(admission.api.begin('inspector', ['entity:hero']), null)
  const inspector = admission.current()
  assert.ok(inspector)
  admission.api.cancel(inspector)
  assert.notEqual(admission.api.begin('viewport', ['entity:hero']), null)
})

test('mounted Inspector transform field unmount cancels focused admission and preserves pending admission until settlement', async () => {
  const WorldsInspector = await loadWorldsInspector()
  const gateway = createGateway(modelFreeSnapshot())
  const controller = createWorldEditorController(gateway)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const admission = createMountedTransformAdmission(controller)
  const host = mountInspector(controller, WorldsInspector, { transformAdmission: admission.api })

  selectByLabelInSection(host, 'Transform', 'X').props.onFocus()
  assert.equal(admission.activeId(), 'transform:inspector:1')
  host.render(null)
  host.flush()
  assert.equal(admission.activeId(), null)

  const pending = admission.api.begin('viewport', ['entity:hero'])
  assert.ok(pending)
  assert.equal(admission.api.release(pending), true)
  assert.equal(admission.api.begin('inspector', ['entity:hero']), null)
  admission.api.finish(pending)
  assert.notEqual(admission.api.begin('inspector', ['entity:hero']), null)
})

function modelFreeSnapshot(): WorldProjectSnapshotV1 {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources = []
  snapshot.scenes[0].entities[0].components = []
  return snapshot
}

function animationPlayerSnapshot(): WorldProjectSnapshotV1 {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push({
    id: 'resource:walk',
    type: 'animation',
    name: 'Walk',
    workspacePath: 'Animations/walk.pose.json',
    format: 'pose-clip',
    sourceWorkspacePath: 'Assets/hero.glb',
    clipName: 'Walk',
    durationSeconds: 2,
  })
  snapshot.scenes[0].entities[0].components.push({
    id: 'component:animation',
    type: 'animation-player',
    enabled: true,
    resourceId: 'resource:walk',
    autoplay: false,
    loop: true,
    speed: 1,
  })
  return snapshot
}

function findAnimationPlayer(snapshot: WorldProjectSnapshotV1) {
  return snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:hero')?.components.find((component) => component.type === 'animation-player') ?? null
}

function getAnimationPlayer(snapshot: WorldProjectSnapshotV1) {
  const player = findAnimationPlayer(snapshot)
  assert.ok(player?.type === 'animation-player')
  return player
}

function createGateway(seed: WorldProjectSnapshotV1) {
  let snapshot = cloneWorldProjectSnapshot(seed)
  return {
    applyCalls: [] as WorldCommandBatchV1[],
    applyGate: null as (() => Promise<void>) | null,
    failNextApply: false,
    get snapshot() { return snapshot },
    replaceSnapshot(next: WorldProjectSnapshotV1) { snapshot = cloneWorldProjectSnapshot(next) },
    async list() { return { ok: true as const, value: { projects: [{ projectKey, status: 'ready' as const, projectId: snapshot.project.projectId, name: snapshot.project.name, revision: snapshot.project.revision }], issues: [] } } },
    async open() { return { ok: true as const, value: { status: 'ready' as const, projectKey, snapshot: cloneWorldProjectSnapshot(snapshot), durabilityWarnings: [] } } },
    async create() { throw new Error('unused') },
    async previewCommands() { throw new Error('unused') },
    async delete() { throw new Error('unused') },
    async applyCommands(request: { batch: WorldCommandBatchV1 }) {
      this.applyCalls.push(structuredClone(request.batch))
      await this.applyGate?.()
      if (this.failNextApply) {
        this.failNextApply = false
        return { ok: false as const, error: { code: 'write_failed' as const, message: 'Deferred component write failed.', retryable: false } }
      }
      const result = applyWorldCommandBatch(snapshot, request.batch)
      if (!result.success) return { ok: false as const, error: { code: 'write_failed' as const, message: result.issues[0]?.message ?? 'Apply failed.', retryable: false } }
      snapshot = cloneWorldProjectSnapshot(result.snapshot)
      return {
        ok: true as const,
        value: {
          projectKey,
          snapshot: cloneWorldProjectSnapshot(snapshot),
          newRevision: snapshot.project.revision,
          idempotent: false,
          changes: result.changes,
          warnings: result.warnings,
          inverse: result.inverse,
          receipt: { ...result.receipt, payloadSha256: '0'.repeat(64), resultSha256: '1'.repeat(64) },
        },
      }
    },
  }
}

async function loadWorldsInspector(): Promise<React.ComponentType<any>> {
  const tempDir = await mkdtemp(path.join('/tmp', 'worlds-inspector-primitive-mounted-'))
  try {
    await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
    await symlink(path.join(projectRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, 'WorldsInspector.tsx')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    })
    const outfile = path.join(tempDir, 'WorldsInspector.bundle.mjs')
    await writeFile(outfile, result.outputFiles[0].text)
    const module = await import(pathToFileURL(outfile).href)
    return module.default ?? module.WorldsInspector
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function mountInspector(controller: WorldEditorController, WorldsInspector: React.ComponentType<any>, options: { errors?: string[]; selectedEntityId?: string | (() => string); transformAdmission?: WorldEditorTransformAdmission; onCommands?: (commands: WorldCommand[], scope: string) => boolean | Promise<boolean> } = {}) {
  const host = mounted()
  let dispatches = 0
  const render = () => {
    const state = controller.getState()
    const snapshot = currentSnapshot(controller)
    const selectedEntityId = typeof options.selectedEntityId === 'function' ? options.selectedEntityId() : options.selectedEntityId ?? 'entity:hero'
    host.render(React.createElement(WorldsInspector, {
      projectKey,
      snapshot,
      scene: snapshot.scenes.find((scene) => scene.sceneId === state.activeSceneId) ?? snapshot.scenes[0],
      selectedEntityIds: [selectedEntityId],
      activeEntityId: selectedEntityId,
      snapEnabled: false,
      snapIncrement: 0.5,
      transformAdmission: options.transformAdmission,
      onSnap: () => undefined,
      onError: (message: string) => { options.errors?.push(message) },
      onCommands: options.onCommands ?? ((commands: WorldCommand[], scope: string) => {
        dispatches += 1
        return controller.dispatchCommands({ transactionId: createWorldUiTransactionId(scope), origin: 'ui', commands }, {
          projectKey,
          projectId: currentSnapshot(controller).project.projectId,
          baseRevision: currentSnapshot(controller).project.revision,
          activeSceneId: controller.getState().activeSceneId ?? 'scene:one',
        }).then((result) => { if (!result.ok) options.errors?.push(result.error.message); return result.ok })
      }),
    }))
  }
  controller.subscribe(render)
  render()
  return { ...host, get dispatches() { return dispatches } }
}

function createMountedTransformAdmission(controller: WorldEditorController) {
  let active: WorldEditorTransformGesture | null = null
  const lease = Object.freeze({ generation: 1 })
  const owner = createWorldEditorTransformAdmission({
    getContext: () => {
      const snapshot = currentSnapshot(controller)
      return { projectKey, activeSceneId: controller.getState().activeSceneId ?? 'scene:one', snapshot }
    },
    getViewportLease: () => lease,
    isViewportCurrent: (candidate) => candidate === lease,
    onError: () => undefined,
    onPendingChange: () => undefined,
  })
  const api: WorldEditorTransformAdmission = {
    begin: (kind, entityIds) => {
      const gesture = owner.begin(kind, entityIds)
      active = gesture
      return gesture
    },
    release: (gesture) => {
      const released = owner.release(gesture)
      if (released && active === gesture) active = null
      return released
    },
    cancel: (gesture) => {
      owner.cancel(gesture)
      if (active === gesture) active = null
    },
    finish: (gesture) => owner.finish(gesture),
    invalidateActive: () => { owner.invalidateActive(); active = null },
    isCurrent: (gesture) => owner.isCurrent(gesture),
    get pending() { return owner.pending },
  }
  return { api, activeId: () => active?.gestureId ?? null, current: () => active }
}

function currentSnapshot(controller: WorldEditorController): WorldProjectSnapshotV1 {
  const snapshot = controller.getState().session?.snapshot
  if (!snapshot) throw new Error('World project is not open.')
  return snapshot
}

function mounted(rootTag = 0) {
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Host['props']) => ({ type, props, children: [] }),
    createTextInstance: (value: string) => ({ type: '#text', props: { value }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props },
    commitTextUpdate: (node: Host, _old: unknown, value: string) => { node.props.value = value },
    hideInstance: (node: Host) => { node.props.hidden = true }, unhideInstance: (node: Host) => { node.props.hidden = false },
    hideTextInstance: (node: Host) => { node.props.hidden = true }, unhideTextInstance: (node: Host) => { node.props.hidden = false },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(container, rootTag, null, false, null, '', () => {}, null)
  return {
    container,
    render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    transition: (value: React.ReactNode) => React.startTransition(() => renderer.updateContainer(value, root, null, null)),
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
  }
}

async function settle(host: ReturnType<typeof mounted>, ticks = 6): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.flush()
  }
}

async function waitFor(host: ReturnType<typeof mounted>, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 120 && !predicate(); attempt += 1) await settle(host, 2)
  assert.equal(predicate(), true)
}

function click(host: ReturnType<typeof mounted>, label: string): void {
  const button = requireButton(host, label)
  assert.equal(button.props.disabled, false)
  button.props.onClick()
}

function requireButton(host: ReturnType<typeof mounted>, label: string): Host {
  return requireNode(host, (node) => node.type === 'button' && node.props['aria-label'] === label, `button ${label}`)
}

function changeSelect(select: Host, value: string): void {
  select.props.onChange({ currentTarget: { value } })
}

function commitNumber(host: ReturnType<typeof mounted>, label: string, value: string): void {
  const input = selectByLabelInSection(host, 'Collider', label)
  input.props.onChange({ currentTarget: { value } })
  host.flush()
  input.props.onBlur()
}

function commitNumberInSection(host: ReturnType<typeof mounted>, heading: string, label: string, value: string): void {
  const input = selectByLabelInSection(host, heading, label)
  input.props.onChange({ currentTarget: { value } })
  host.flush()
  input.props.onBlur()
}

function changeCheckbox(input: Host, checked: boolean): void {
  input.props.onChange({ currentTarget: { checked } })
}

function selectByLabelInSection(host: ReturnType<typeof mounted>, heading: string, label: string): Host {
  const section = requireNode(host, (node) => node.type === 'section' && text(node).includes(heading), `section ${heading}`)
  return selectByLabelWithin(section, label)
}

function selectByLabelWithin(section: Host, label: string): Host {
  const labelNode = find(section, (node) => node.type === 'label' && text(node).includes(label))
  if (!labelNode) throw new assert.AssertionError({ message: `label ${label}`, actual: labelNode, expected: true, operator: '==' })
  const control = find(labelNode, (node) => node.type === 'select' || node.type === 'input')
  if (!control) throw new assert.AssertionError({ message: `control ${label}`, actual: control, expected: true, operator: '==' })
  return control
}

function controlsByLabelWithin(section: Host, label: string): Host[] {
  return collect(section, (node) => node.type === 'label' && text(node).includes(label))
    .map((labelNode) => find(labelNode, (node) => node.type === 'select' || node.type === 'input'))
    .filter((node): node is Host => !!node)
}

function requireNode(host: ReturnType<typeof mounted>, predicate: (node: Host) => boolean, label: string): Host {
  const found = find(host.container, predicate)
  if (!found) throw new assert.AssertionError({ message: label, actual: found, expected: true, operator: '==' })
  return found
}

function find(node: Host, predicate: (node: Host) => boolean): Host | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = find(child, predicate)
    if (found) return found
  }
  return undefined
}

function collect(node: Host, predicate: (node: Host) => boolean): Host[] {
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => collect(child, predicate)),
  ]
}

function text(node: Host): string {
  if (node.type === '#text') return String(node.props.value)
  return node.children.map(text).join('')
}
