import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWorldProjectPickerKey } from './worldProjectPickerModel.ts'

const projects = [
  { projectKey: 'world:a', status: 'ready' as const },
  { projectKey: 'world:b', status: 'ready' as const },
]

test('project picker follows authority changes but preserves an explicit pending selection', () => {
  assert.equal(resolveWorldProjectPickerKey({
    currentPickerKey: 'world:a',
    currentProjectKey: 'world:a',
    previousProjectKey: null,
    projects,
  }), 'world:a')

  assert.equal(resolveWorldProjectPickerKey({
    currentPickerKey: 'world:b',
    currentProjectKey: 'world:a',
    previousProjectKey: 'world:a',
    projects,
  }), 'world:b')

  assert.equal(resolveWorldProjectPickerKey({
    currentPickerKey: 'world:a',
    currentProjectKey: 'world:b',
    previousProjectKey: 'world:a',
    projects,
  }), 'world:b')
})

test('project picker survives list refreshes and replaces only stale selections', () => {
  assert.equal(resolveWorldProjectPickerKey({
    currentPickerKey: 'world:b',
    currentProjectKey: 'world:a',
    previousProjectKey: 'world:a',
    projects: [...projects].reverse(),
  }), 'world:b')

  assert.equal(resolveWorldProjectPickerKey({
    currentPickerKey: 'world:removed',
    currentProjectKey: 'world:a',
    previousProjectKey: 'world:a',
    projects,
  }), 'world:a')

  assert.equal(resolveWorldProjectPickerKey({
    currentPickerKey: '',
    currentProjectKey: null,
    previousProjectKey: null,
    projects,
  }), 'world:a')
})
