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
  assert.match(nodeBehaviorsSource, /addToSceneNode:\s*\{[^}]*sceneOutput: true/ )
  assert.match(runStoreSource, /targetType === 'addToWorldsNode'/)
  assert.match(runStoreSource, /isSceneOutput\(targetType\)/)
  assert.match(runStoreSource, /const runId = crypto\.randomUUID\(\)\s*const jobId = runId/)
  assert.match(runStoreSource, /id:\s*jobId/)
  assert.match(runStoreSource, /runId: ctx\.runId, sourceNodeId: inEdge\.source, targetNodeId: inEdge\.target/)
  assert.match(runStoreSource, /artifactId: outputKey \? ctx\.nodeArtifacts\.get\(outputKey\)\?\.id : undefined/)
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
    /if \(worldsUrl && targetType === 'addToWorldsNode'\) \{\s*const kind = selectedOutput\?\.outputType\s*const outputKey = runEdgeOutputKey\(ctx, edge\)\s*await routeWorkflowOutputToWorlds\(worldsUrl, isArtifactKind\(kind\) \? kind : undefined, \{\s*runId: ctx\.runId, sourceNodeId: edge\.source, targetNodeId: edge\.target,\s*artifactId: outputKey \? ctx\.nodeArtifacts\.get\(outputKey\)\?\.id : undefined,\s*\}\)/,
  )
  const worldsOutputSource = await readFile(path.join(workflowsRoot, 'workflowWorldsOutput.ts'), 'utf8')
  assert.match(worldsOutputSource, /useAppStore\.getState\(\)\.apiUrl/)
  assert.match(worldsOutputSource, /libraryApi\.read\(\{ workspacePath \}\)/)
  assert.match(worldsOutputSource, /resolveWorldRenderable\(\{ workspacePath, apiUrl, .*plyKind/s)
  assert.match(worldsOutputSource, /worldEditorCommandPort/)
  assert.doesNotMatch(worldsOutputSource, /worldsSceneStore|useWorldsSceneStore/)
  assert.match(edgeColorsSource, /targetNodeType === 'outputNode' \|\| targetNodeType === 'addToWorldsNode'/)
})
