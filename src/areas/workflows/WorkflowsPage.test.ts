import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const sourcePath = path.join(import.meta.dirname, 'WorkflowsPage.tsx')

test('WorkflowsPage keeps workflow tabs visible while refreshing the workflow list', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /\{!loading && \(/)
  assert.match(source, /Refreshing…/)
  assert.match(source, /workflows\.map\(\(wf\) =>/)
})


test('WorkflowsPage source never disables Run because of semantic process validation', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /validateWorkflowProcessRun/)
  assert.doesNotMatch(source, /setConnectionIssue\(runValidationIssue\)/)
  assert.doesNotMatch(source, /disabled=!isRunning && Boolean\(runValidationIssue\)/)
  assert.match(source, /title="Run workflow"/)
})
