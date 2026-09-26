import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldEditorViewportSelectionHandler } from './useWorldEditorProjectionBridge.ts'
import { useWorldsUiStore } from './worldsUiStore.ts'

test('toolbar activates A within A+B without discarding the multi-selection', (context) => {
  const previous = useWorldsUiStore.getState()
  context.after(() => useWorldsUiStore.setState(previous, true))
  previous.setSelection(['A', 'B'], 'B')

  const state = useWorldsUiStore.getState()
  const onSelectItem = createWorldEditorViewportSelectionHandler(state.selectedEntityIds, state.setSelection)
  onSelectItem('A', { preserveSelection: true })

  assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, ['A', 'B'])
  assert.equal(useWorldsUiStore.getState().activeEntityId, 'A')
})

test('toolbar choosing new C replaces A+B with C and clearing removes selection', (context) => {
  const previous = useWorldsUiStore.getState()
  context.after(() => useWorldsUiStore.setState(previous, true))
  previous.setSelection(['A', 'B'], 'B')

  const state = useWorldsUiStore.getState()
  const onSelectItem = createWorldEditorViewportSelectionHandler(state.selectedEntityIds, state.setSelection)
  onSelectItem('C', { preserveSelection: true })
  assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, ['C'])
  assert.equal(useWorldsUiStore.getState().activeEntityId, 'C')

  onSelectItem(null, { preserveSelection: true })
  assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, [])
  assert.equal(useWorldsUiStore.getState().activeEntityId, null)
})

test('Ctrl-toggle removes A separately from toolbar activation and can add it back', (context) => {
  const previous = useWorldsUiStore.getState()
  context.after(() => useWorldsUiStore.setState(previous, true))
  previous.setSelection(['A', 'B'], 'A')

  let state = useWorldsUiStore.getState()
  createWorldEditorViewportSelectionHandler(state.selectedEntityIds, state.setSelection)('A', { toggle: true })
  assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, ['B'])
  assert.equal(useWorldsUiStore.getState().activeEntityId, 'B')

  state = useWorldsUiStore.getState()
  createWorldEditorViewportSelectionHandler(state.selectedEntityIds, state.setSelection)('A', { toggle: true })
  assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, ['B', 'A'])
  assert.equal(useWorldsUiStore.getState().activeEntityId, 'A')

  state = useWorldsUiStore.getState()
  createWorldEditorViewportSelectionHandler(state.selectedEntityIds, state.setSelection)(null, { toggle: true })
  assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, ['B', 'A'])
})
