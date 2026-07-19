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
  assert.doesNotMatch(workflowPanelSource, /validateWorkflowProcessRun/)

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


test('named-output model nodes keep an anonymous primary source alias for legacy edges', async () => {
  const source = await readWorkflowFile('nodes/ExtensionNode.tsx')
  assert.match(source, /key="__primary-source-alias"/)
  assert.match(source, /isConnectable=\{false\}/)
  assert.match(source, /sourcePorts\.map\(\(port, index\)/)
})

test('extension node tag classes keep scene and audio styling on distinct keys', async () => {
  const source = await readWorkflowFile('nodes/ExtensionNode.tsx')

  assert.match(source, /scene:\s*'border-emerald-500\/30 bg-emerald-500\/10 text-emerald-400'/)
  assert.match(source, /audio:\s*'border-pink-500\/30 bg-pink-500\/10 text-pink-400'/)
  assert.equal(source.match(/\baudio:\s*'/g)?.length, 1)
})
