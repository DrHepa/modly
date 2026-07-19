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


test('WorkflowsPage persists a stable targetItemIndex only for repeatable ports', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /function withStableTargetItemIndex/)
  assert.match(source, /if \(!port\?\.multiple\) return args\.connection/)
  assert.match(source, /targetItemIndex: highestIndex \+ 1/)
  assert.match(source, /addEdge\(\{ \.\.\.indexedConnection, \.\.\.DEFAULT_EDGE_OPTS \}/)
})

test('WorkflowsPage stores ioContract only for named-v1 model workflow nodes', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /function createWorkflowExtensionNode/)
  assert.match(source, /const ioContract = resolveEffectiveWorkflowIoContract\(node, extension\)/)
  assert.match(source, /extension\?\.type !== 'model' \|\| ioContract !== 'named-v1'/)
  assert.match(source, /data: \{ \.\.\.node\.data, ioContract \}/)
  assert.equal(source.match(/createWorkflowExtensionNode\(\{/g)?.length, 2)
})

test('WorkflowsPage source never disables Run because of semantic process validation', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /validateWorkflowProcessRun/)
  assert.doesNotMatch(source, /setConnectionIssue\(runValidationIssue\)/)
  assert.doesNotMatch(source, /disabled=!isRunning && Boolean\(runValidationIssue\)/)
  assert.match(source, /title="Run workflow"/)
})
