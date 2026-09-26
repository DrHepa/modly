import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_PROJECT_CHANNELS,
  WORLD_PROJECT_PUBLIC_ERROR_CODES,
  isWorldProjectKey,
} from './worldProjects.ts'

test('Worlds project channels expose the exact narrow project API', () => {
  assert.deepEqual(WORLD_PROJECT_CHANNELS, {
    create: 'workspace:worlds:projects:create',
    list: 'workspace:worlds:projects:list',
    open: 'workspace:worlds:projects:open',
    previewCommands: 'workspace:worlds:projects:previewCommands',
    applyCommands: 'workspace:worlds:projects:applyCommands',
    previewAi: 'workspace:worlds:projects:previewAi',
    discardAi: 'workspace:worlds:projects:discardAi',
    delete: 'workspace:worlds:projects:delete',
  })
  assert.deepEqual(Object.keys(WORLD_PROJECT_CHANNELS).sort(), [
    'applyCommands', 'create', 'delete', 'discardAi', 'list', 'open', 'previewAi', 'previewCommands',
  ])
})

test('public errors are stable, sanitized codes', () => {
  assert.deepEqual(WORLD_PROJECT_PUBLIC_ERROR_CODES, [
    'invalid_request',
    'project_not_found',
    'revision_conflict',
    'transaction_reuse',
    'unsafe_workspace',
    'invalid_document',
    'unsupported_schema',
    'project_busy',
    'recovery_failed',
    'write_failed',
    'unauthorized',
    'internal_error',
  ])
})

test('project keys are opaque portable ASCII segments', () => {
  assert.equal(isWorldProjectKey('world-0123456789abcdef0123456789abcdef'), true)
  for (const value of [
    '', '.', '..', 'world/demo', 'world\\demo', 'C:\\world', '/tmp/world',
    'world-%2e%2e', 'World-0123456789ABCDEF', 'world-short',
  ]) assert.equal(isWorldProjectKey(value), false, value)
})
