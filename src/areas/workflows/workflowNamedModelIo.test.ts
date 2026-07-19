import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const sourcePath = path.join(import.meta.dirname, 'workflowRunStore.ts')

test('workflow model dispatch preserves ordered repeated images and typed named results', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /const leftIndex = Number\.isInteger\(left\.edge\.targetItemIndex\)/)
  assert.match(source, /: left\.edgeIndex/)
  assert.match(source, /return leftIndex - rightIndex \|\| left\.edgeIndex - right\.edgeIndex/)
  assert.match(source, /fd\.append\('images', blob/)
  assert.match(source, /'\/generate\/from-images'/)
  assert.match(source, /getWorkflowNodeOutputKey\(node\.id, output\.source_handle\)/)
  assert.match(source, /if \(st\.status === 'done'\)/)
  assert.match(source, /primaryOutput = \{ text: st\.text, outputType \}/)
  assert.doesNotMatch(source, /st\.status === 'done' && st\.output_url/)
})
