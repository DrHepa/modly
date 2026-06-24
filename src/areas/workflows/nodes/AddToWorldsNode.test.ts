import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { resolveWorkflowOutputWorldsWorkspacePath } from '../workflowWorldsOutput.ts'

const sourcePath = path.join(import.meta.dirname, 'AddToWorldsNode.tsx')

test('AddToWorldsNode is a standalone stable Worlds destination node', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /title="Add to Worlds"/)
  assert.match(source, /Add to Worlds/)
  assert.match(source, /Automatically adds the connected mesh to Worlds when the workflow runs\./)
  assert.doesNotMatch(source, /checkbox|Open in Worlds|openInWorlds/)
  assert.doesNotMatch(source, /button|onClick|navigate\('worlds'\)|setWorldsError|text-red|fetch\(/)
})

test('resolveWorkflowOutputWorldsWorkspacePath accepts only safe workspace URLs', () => {
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/Workflows/generated/hero.glb'), 'Workflows/generated/hero.glb')
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('http://127.0.0.1:8765/workspace/Exports/hero.glb'), 'Exports/hero.glb')
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/Workflows/%68ero.glb'), 'Workflows/hero.glb')
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/../outside.glb'), null)
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/%2e%2e/outside.glb'), null)
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/not-workspace/hero.glb'), null)
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/C:/outside.glb'), null)
})
