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
  const workflowRunStoreSource = await readWorkflowFile('workflowRunStore.ts')

  assert.match(workflowsPageSource, /from '\.\/workflowRunStore'/)
  assert.doesNotMatch(workflowsPageSource, /useWorkflowRunner/)

  assert.match(workflowPanelSource, /workflowRunStore/)
  assert.doesNotMatch(workflowPanelSource, /useWorkflowRunner/)

  assert.match(extensionNodeSource, /workflowRunStore/)
  assert.doesNotMatch(extensionNodeSource, /useWorkflowRunner/)

  assert.match(workflowRunStoreSource, /buildProcessExecutionInput/)
  assert.doesNotMatch(workflowRunStoreSource, /useWorkflowRunner/)
})
