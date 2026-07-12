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
  assert.match(workflowRunStoreSource, /from '\.\/workflowDispatch(?:\.ts)?'/)
  assert.match(workflowRunStoreSource, /resolveWorkflowDispatch\(/)
  assert.doesNotMatch(workflowRunStoreSource, /useWorkflowRunner/)
})


test('inputless model nodes expose no target socket and skip predecessor fallback', async () => {
  const extensionNodeSource = await readWorkflowFile('nodes/ExtensionNode.tsx')
  const runStoreSource = await readWorkflowFile('workflowRunStore.ts')

  assert.match(extensionNodeSource, /ext\?\.input === 'none'\s*\? \[\]/)
  assert.match(extensionNodeSource, /ext\?\.input !== 'none'/)
  assert.match(runStoreSource, /export function shouldUsePreviousNodeFallback[\s\S]*return input !== 'none'/)
  assert.match(runStoreSource, /else if \(shouldUsePreviousNodeFallback\(ext\.input\)\)/)
  assert.match(runStoreSource, /request\.kind === 'none'[\s\S]*'\/generate\/from-none'/)
  assert.match(runStoreSource, /actualOutput: st\.output_kind/)
  assert.doesNotMatch(runStoreSource, /from-none[\s\S]{0,300}(?:readFileBase64|FormData)/)
})
