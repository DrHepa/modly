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
  const nodeBehaviorsSource = await readFile(path.join(workflowsRoot, 'nodeBehaviors.ts'), 'utf8')

  assert.match(nodeTypesSource, /addToWorldsNode: AddToWorldsNode/)
  assert.match(connectionRulesSource, /node\.type === 'outputNode' \|\| node\.type === 'addToWorldsNode'/)
  assert.match(processExecutionSource, /node\.type === 'outputNode' \|\| node\.type === 'addToWorldsNode'/)
  assert.match(nodeBehaviorsSource, /outputNode:\s*\{\s*sceneOutput: true,\s*branchConsumer: true\s*\}/)
  assert.match(runStoreSource, /interface RunContext\s*\{[^}]*nodeOutputs:\s*Map<string, NodeOutput>[^}]*nodeMap:\s*Map<string, WFNode>/)
  assert.match(
    runStoreSource,
    /for \(const edge of workflow\.edges\.filter\(\(candidate\) => candidate\.source === node\.id\)\) \{\s*const targetType = nodeMap\.get\(edge\.target\)\?\.type\s*const selectedOutput = resolveSource\(edge\)/,
  )
  assert.match(
    runStoreSource,
    /if \(url && !isBranchStarter\(targetType\)\s*&& \(isSceneOutput\(targetType\) \|\| reachesSceneOutput\(edge\.target, workflow\.edges, nodeMap\)\)\) \{\s*ctx\.lastSceneMesh = url/,
  )
  assert.match(
    runStoreSource,
    /if \(worldsUrl && targetType === 'addToWorldsNode'\) \{\s*const kind = selectedOutput\?\.outputType\s*await addWorkflowOutputUrlToWorlds\(worldsUrl, isArtifactKind\(kind\) \? kind : undefined\)/,
  )
  const worldsOutputSource = await readFile(path.join(workflowsRoot, 'workflowWorldsOutput.ts'), 'utf8')
  assert.match(worldsOutputSource, /useAppStore\.getState\(\)\.apiUrl/)
  assert.match(worldsOutputSource, /libraryApi\.read\(\{ workspacePath \}\)/)
  assert.match(worldsOutputSource, /resolveWorldRenderable\(\{ workspacePath, apiUrl, .*plyKind/s)
  assert.match(edgeColorsSource, /targetNodeType === 'outputNode' \|\| targetNodeType === 'addToWorldsNode'/)
})
