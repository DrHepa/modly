import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import * as mod from './viewerAuthoringHost.ts'

const viewerAuthoringHostComponentSource = () => readFile(
  new URL('./components/ViewerAuthoringHost.tsx', import.meta.url),
  'utf8',
)

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

test('viewer authoring host context helper defaults every optional flag to false', () => {
  assert.deepEqual(mod.createViewerAuthoringHostContext({}), {
    hasModel: false,
    meshSelected: false,
    hasTransformTools: false,
  })
})

test('viewer authoring host context helper preserves explicit true flags', () => {
  assert.deepEqual(mod.createViewerAuthoringHostContext({
    hasModel: true,
    meshSelected: true,
    hasTransformTools: true,
  }), {
    hasModel: true,
    meshSelected: true,
    hasTransformTools: true,
  })
})

test('viewer authoring host context helper keeps transform tools disabled unless explicitly enabled', () => {
  assert.deepEqual(mod.createViewerAuthoringHostContext({
    hasModel: true,
    meshSelected: true,
  }), {
    hasModel: true,
    meshSelected: true,
    hasTransformTools: false,
  })
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

test('view toolbar contribution remains visible with a model regardless of selection and transform tools', () => {
  const resolve = (ctx) => mod.resolveViewerAuthoringContributions(
    mod.DEFAULT_VIEWER_AUTHORING_CONTRIBUTIONS,
    ctx,
  ).map(({ id }) => id)

  assert.deepEqual(resolve({ hasModel: true, meshSelected: false, hasTransformTools: false }), ['view-toolbar'])
  assert.deepEqual(resolve({ hasModel: true, meshSelected: true, hasTransformTools: false }), ['view-toolbar'])
  assert.deepEqual(resolve({ hasModel: true, meshSelected: false, hasTransformTools: true }), ['view-toolbar'])
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

test('ViewerAuthoringHost component exposes a minimal internal prop contract', async () => {
  const source = await viewerAuthoringHostComponentSource()

  assert.match(source, /export interface ViewerAuthoringHostProps \{[\s\S]*children: ReactNode/)
  assert.match(source, /export interface ViewerAuthoringHostProps \{[\s\S]*hasModel: boolean/)
  assert.match(source, /export interface ViewerAuthoringHostProps \{[\s\S]*contributions: readonly ResolvedViewerAuthoringContribution\[\]/)
  assert.match(source, /export interface ViewerAuthoringHostSlots \{[\s\S]*viewRail\?: ReactNode/)
  assert.match(source, /slots\?: ViewerAuthoringHostSlots/)
  assert.match(source, /<div className="relative w-full h-full bg-surface-400">[\s\S]*\{children\}[\s\S]*\{slots\?\.viewRail\}/)
  assert.equal(source.includes('createContext'), false)
  assert.equal(source.includes('manifest'), false)
  assert.equal(source.includes('plugin'), false)
  assert.equal(source.includes('permissions'), false)
})
