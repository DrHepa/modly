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
