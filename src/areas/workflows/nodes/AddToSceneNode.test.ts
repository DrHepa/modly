import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { resolveWorkflowOutputWorldsWorkspacePath } from '../workflowWorldsOutput.ts'

const sourcePath = path.join(import.meta.dirname, 'AddToSceneNode.tsx')

test('AddToSceneNode preserves Generate as the default destination', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /const openInWorlds = data\.params\.openInWorlds === true/)
  assert.match(source, /navigate\('generate'\)/)
  assert.match(source, /setCurrentJob\(\{ id: 'workflow-output'/)
})

test('AddToSceneNode persists a boolean option and navigates workflow output to Worlds when enabled', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /aria-label="Open workflow output in Worlds"/)
  assert.match(source, /updateNodeData\(id, \{ params: \{ \.\.\.data\.params, openInWorlds: !openInWorlds \} \}\)/)
  assert.match(source, /resolveWorkflowOutputWorldsWorkspacePath\(outputUrl\)/)
  assert.match(source, /appendWorldSceneItem\(useWorldsSceneStore\.getState\(\)\.sceneItems, renderable\.item\)/)
  assert.match(source, /navigate\('worlds'\)/)
})

test('AddToSceneNode does not invent backend dispatch for Worlds', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /window\.electron\.(?!.*settings)/)
  assert.doesNotMatch(source, /fetch\(/)
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
