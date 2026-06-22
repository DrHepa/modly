import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const sourcePath = path.join(import.meta.dirname, 'AddToSceneNode.tsx')

test('AddToSceneNode preserves the stable Generate 3D scene destination', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /navigate\('generate'\)/)
  assert.match(source, /setCurrentJob\(\{ id: 'workflow-output'/)
  assert.match(source, /Add to 3D scene/)
})

test('AddToSceneNode does not embed Worlds routing inside the base scene output node', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /Open in Worlds/)
  assert.doesNotMatch(source, /openInWorlds/)
  assert.doesNotMatch(source, /navigate\('worlds'\)/)
  assert.doesNotMatch(source, /useWorldsSceneStore/)
  assert.doesNotMatch(source, /appendWorldSceneItem/)
})

test('AddToSceneNode does not invent backend dispatch for Worlds', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /window\.electron\.(?!.*settings)/)
  assert.doesNotMatch(source, /fetch\(/)
})
