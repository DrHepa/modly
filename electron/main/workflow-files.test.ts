import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import { importWorkflowAvoidingIdCollision, listStoredWorkflows, saveWorkflowWithBackup } from './workflow-files.ts'

const workflow = (id: string, name: string, updatedAt = '2026-06-22T18:00:00.000Z') => ({
  id,
  name,
  nodes: [],
  edges: [],
  createdAt: updatedAt,
  updatedAt,
})

test('listStoredWorkflows reports filename/id mismatches and deduplicates by workflow id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'modly-workflows-list-'))
  await writeFile(join(dir, 'wrong-file.json'), JSON.stringify(workflow('same-id', 'Old', '2026-06-22T17:00:00.000Z')), 'utf-8')
  await writeFile(join(dir, 'same-id.json'), JSON.stringify(workflow('same-id', 'New', '2026-06-22T18:00:00.000Z')), 'utf-8')

  const result = await listStoredWorkflows(dir)

  assert.equal(result.workflows.length, 1)
  assert.equal(result.workflows[0].name, 'New')
  assert.deepEqual(result.diagnostics.filenameIdMismatches, [{ file: 'wrong-file.json', fileId: 'wrong-file', workflowId: 'same-id' }])
  assert.deepEqual(result.diagnostics.duplicateIds, [{ workflowId: 'same-id', files: ['same-id.json', 'wrong-file.json'] }])
})

test('saveWorkflowWithBackup copies the previous workflow before overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'modly-workflows-save-'))
  await writeFile(join(dir, 'workflow-id.json'), JSON.stringify(workflow('workflow-id', 'Before')), 'utf-8')

  const result = await saveWorkflowWithBackup(dir, workflow('workflow-id', 'After'), new Date(2026, 5, 22, 20, 36, 5))

  assert.equal(result.success, true)
  assert.equal(result.backupPath, join(dir, '.backups', '2026-06-22-203605', 'workflow-id.json'))
  assert.equal(JSON.parse(await readFile(result.backupPath!, 'utf-8')).name, 'Before')
  assert.equal(JSON.parse(await readFile(join(dir, 'workflow-id.json'), 'utf-8')).name, 'After')
})

test('importWorkflowAvoidingIdCollision generates a new id instead of overwriting existing workflows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'modly-workflows-import-'))
  const source = join(dir, 'source.json')
  await writeFile(join(dir, 'existing-id.json'), JSON.stringify(workflow('existing-id', 'Existing')), 'utf-8')
  await writeFile(source, JSON.stringify(workflow('existing-id', 'Imported')), 'utf-8')

  const result = await importWorkflowAvoidingIdCollision(dir, source)

  assert.equal(result.success, true)
  assert.equal(result.originalId, 'existing-id')
  assert.equal(typeof result.workflow?.id, 'string')
  assert.notEqual(result.workflow?.id, 'existing-id')
  assert.equal(result.workflow?.name, 'Imported (imported)')
})
