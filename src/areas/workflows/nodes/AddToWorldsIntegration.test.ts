import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const workflowsRoot = path.resolve(import.meta.dirname, '..')

test('Add to Worlds is wired as a mesh terminal without changing Add to Scene', async () => {
  const nodeTypesSource = await readFile(path.join(workflowsRoot, 'workflowNodeTypes.tsx'), 'utf8')
  const connectionRulesSource = await readFile(path.join(workflowsRoot, 'processConnectionRules.ts'), 'utf8')
  const processExecutionSource = await readFile(path.join(workflowsRoot, 'processExecution.ts'), 'utf8')
  const runStoreSource = await readFile(path.join(workflowsRoot, 'workflowRunStore.ts'), 'utf8')
  const edgeColorsSource = await readFile(path.join(workflowsRoot, 'nodes/workflowEdgeColors.ts'), 'utf8')

  assert.match(nodeTypesSource, /addToWorldsNode: AddToWorldsNode/)
  assert.match(connectionRulesSource, /node\.type === 'outputNode' \|\| node\.type === 'addToWorldsNode'/)
  assert.match(processExecutionSource, /node\.type === 'outputNode' \|\| node\.type === 'addToWorldsNode'/)
  assert.match(runStoreSource, /const addToSceneNodeIds = new Set/)
  assert.match(runStoreSource, /const addToWorldsNodeIds = new Set/)
  assert.match(runStoreSource, /const sceneOutputNodeIds = new Set\(\[\.\.\.addToSceneNodeIds, \.\.\.addToWorldsNodeIds\]\)/)
  assert.match(
    runStoreSource,
    /await addWorkflowOutputUrlToWorlds\(\s*selectedUrl,\s*isArtifactKind\(selectedOutputType\) \? selectedOutputType : undefined,\s*\)/,
  )
  const worldsOutputSource = await readFile(path.join(workflowsRoot, 'workflowWorldsOutput.ts'), 'utf8')
  assert.match(worldsOutputSource, /useAppStore\.getState\(\)\.apiUrl/)
  assert.match(worldsOutputSource, /libraryApi\.read\(\{ workspacePath \}\)/)
  assert.match(worldsOutputSource, /resolveWorldRenderable\(\{ workspacePath, apiUrl, .*plyKind/s)
  assert.match(edgeColorsSource, /targetNodeType === 'outputNode' \|\| targetNodeType === 'addToWorldsNode'/)
})
