import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function readWorkflowFile(relativePath: string): Promise<string> {
  return readFile(path.join(__dirname, relativePath), 'utf8')
}

test('runtime workflow entrypoints use workflowRunStore instead of useWorkflowRunner', async () => {
  const workflowsPageSource = await readWorkflowFile('WorkflowsPage.tsx')
  const workflowPanelSource = await readWorkflowFile('../generate/components/WorkflowPanel.tsx')
  const extensionNodeSource = await readWorkflowFile('nodes/ExtensionNode.tsx')

  assert.match(workflowsPageSource, /from '\.\/workflowRunStore'/)
  assert.doesNotMatch(workflowsPageSource, /useWorkflowRunner/)

  assert.match(workflowPanelSource, /workflowRunStore/)
  assert.doesNotMatch(workflowPanelSource, /useWorkflowRunner/)

  assert.match(extensionNodeSource, /workflowRunStore/)
  assert.doesNotMatch(extensionNodeSource, /useWorkflowRunner/)
})

test('legacy useWorkflowRunner hook is explicitly marked as inactive parity path', async () => {
  const source = await readWorkflowFile('useWorkflowRunner.ts')

  assert.match(source, /workflowRunStore is the sole active workflow execution path/)
  assert.match(source, /buildProcessExecutionInput/)
})
