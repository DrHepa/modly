import test from 'node:test'
import assert from 'node:assert/strict'
import * as mod from './viewerAuthoringHost.ts'

test('host slots are explicit and stable through contribution descriptors', () => {
  assert.deepEqual(mod.VIEWER_AUTHORING_HOST_SLOTS, [
    'view-rail',
    'edit-rail',
    'top-right',
    'top-right-stack',
    'bottom-drawer',
  ])
  assert.deepEqual(
    mod.DEFAULT_VIEWER_AUTHORING_CONTRIBUTIONS.map(({ id, slot }) => ({ id, slot })),
    [
      { id: 'view-toolbar', slot: 'view-rail' },
      { id: 'transform-toolbar', slot: 'edit-rail' },
    ],
  )
})

test('hidden contributions are omitted when their visibility predicate is false', () => {
  const contributions = [
    {
      id: 'view-toolbar',
      slot: 'view-rail',
      order: 10,
      label: 'View toolbar',
      kind: 'toolbar',
      isVisible: () => false,
    },
  ]

  assert.deepEqual(
    mod.resolveViewerAuthoringContributions(contributions, {
      hasModel: true,
      meshSelected: true,
      hasTransformTools: true,
    }),
    [],
  )
})

test('transform toolbar contribution is visible only with model, mesh selection, and transform tools', () => {
  const resolve = (ctx) => mod.resolveViewerAuthoringContributions(
    mod.DEFAULT_VIEWER_AUTHORING_CONTRIBUTIONS,
    ctx,
  ).map(({ id }) => id)

  assert.deepEqual(resolve({ hasModel: false, meshSelected: true, hasTransformTools: true }), [])
  assert.deepEqual(resolve({ hasModel: true, meshSelected: false, hasTransformTools: true }), ['view-toolbar'])
  assert.deepEqual(resolve({ hasModel: true, meshSelected: true, hasTransformTools: false }), ['view-toolbar'])
  assert.deepEqual(resolve({ hasModel: true, meshSelected: true, hasTransformTools: true }), [
    'view-toolbar',
    'transform-toolbar',
  ])
})

test('contribution sorting is deterministic by slot, order, and id', () => {
  const visible = {
    label: 'Toolbar',
    kind: 'toolbar',
    isVisible: () => true,
  }
  const contributions = [
    { ...visible, id: 'transform-toolbar', slot: 'edit-rail', order: 20 },
    { ...visible, id: 'view-toolbar', slot: 'view-rail', order: 30 },
    { ...visible, id: 'transform-toolbar', slot: 'edit-rail', order: 10 },
    { ...visible, id: 'view-toolbar', slot: 'view-rail', order: 10 },
  ]

  assert.deepEqual(
    mod.resolveViewerAuthoringContributions(contributions, {
      hasModel: true,
      meshSelected: true,
      hasTransformTools: true,
    }).map(({ slot, order, id }) => `${slot}:${order}:${id}`),
    [
      'view-rail:10:view-toolbar',
      'view-rail:30:view-toolbar',
      'edit-rail:10:transform-toolbar',
      'edit-rail:20:transform-toolbar',
    ],
  )
})

test('resolved host contributions do not expose an external plugin platform surface', () => {
  const [resolved] = mod.resolveViewerAuthoringContributions(
    mod.DEFAULT_VIEWER_AUTHORING_CONTRIBUTIONS,
    { hasModel: true, meshSelected: false, hasTransformTools: true },
  )

  assert.deepEqual(Object.keys(resolved).sort(), ['id', 'kind', 'label', 'order', 'slot'])
  assert.equal('manifest' in resolved, false)
  assert.equal('permissions' in resolved, false)
  assert.equal('plugin' in resolved, false)
})
