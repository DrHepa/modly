import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKFLOW_TAB_SESSION_KEY,
  WORKFLOW_TAB_SESSION_VERSION,
  createWorkflowTabSession,
  parseWorkflowTabSession,
  readWorkflowTabSession,
  reconcileWorkflowTabSession,
  writeWorkflowTabSession,
} from './workflowTabSession'

test('parseWorkflowTabSession validates schema and repairs duplicate ids', () => {
  const parsed = parseWorkflowTabSession(JSON.stringify({
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['b', 'b', 'a'],
    activeId: 'missing',
  }))

  assert.deepEqual(parsed, {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['b', 'a'],
    activeId: 'b',
  })
})

test('parseWorkflowTabSession rejects malformed or wrong-typed payloads', () => {
  assert.equal(parseWorkflowTabSession('{bad-json'), null)
  assert.equal(parseWorkflowTabSession(JSON.stringify({ version: 2, openIds: [], activeId: null })), null)
  assert.equal(parseWorkflowTabSession(JSON.stringify({ version: 1, openIds: 'bad', activeId: null })), null)
  assert.equal(parseWorkflowTabSession(JSON.stringify({ version: 1, openIds: [], activeId: 42 })), null)
})

test('readWorkflowTabSession distinguishes missing key from invalid stored value', () => {
  assert.deepEqual(readWorkflowTabSession({ getItem: () => null }), { exists: false, session: null })
  assert.deepEqual(readWorkflowTabSession({ getItem: () => '{bad-json' }), { exists: true, session: null })
})

test('reconcileWorkflowTabSession preserves explicit closed-all and repairs missing ids', () => {
  assert.deepEqual(
    reconcileWorkflowTabSession({
      exists: true,
      session: createWorkflowTabSession([], null),
    }, ['latest', 'older']),
    { version: WORKFLOW_TAB_SESSION_VERSION, openIds: [], activeId: null },
  )

  assert.deepEqual(
    reconcileWorkflowTabSession({
      exists: true,
      session: createWorkflowTabSession(['deleted-a', 'deleted-b'], 'deleted-b'),
    }, ['latest', 'older']),
    { version: WORKFLOW_TAB_SESSION_VERSION, openIds: ['latest'], activeId: 'latest' },
  )
})

test('writeWorkflowTabSession swallows storage failures safely', () => {
  const writes = new Map<string, string>()
  writeWorkflowTabSession(createWorkflowTabSession(['a'], 'a'), {
    setItem(key: string, value: string) {
      writes.set(key, value)
      throw new Error('quota exceeded')
    },
  })

  assert.equal(writes.has(WORKFLOW_TAB_SESSION_KEY), true)
})
