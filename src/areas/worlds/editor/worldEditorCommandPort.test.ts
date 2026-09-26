import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldEditorController } from './worldEditorController.ts'
import { createWorldEditorCommandPort } from './worldEditorCommandPort.ts'
import type { WorldProjectsApi } from '../../../shared/types/worldProjects.ts'

test('command port exposes command authority without any snapshot setter', () => {
  const controller = createWorldEditorController({} as WorldProjectsApi)
  const port = createWorldEditorCommandPort(controller)
  assert.equal(typeof port.dispatchCommands, 'function')
  assert.equal(typeof port.previewProposal, 'function')
  assert.equal(typeof port.applyProposalExact, 'function')
  assert.equal(typeof port.undo, 'function')
  assert.equal('setSnapshot' in port, false)
  assert.equal('setSession' in port, false)
  assert.equal('setState' in port, false)
  assert.equal(port.getActiveContext(), null)
})
