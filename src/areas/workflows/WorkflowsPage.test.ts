import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const sourcePath = path.join(import.meta.dirname, 'WorkflowsPage.tsx')
const obsoleteEdgeOrderToken = 'targetItem' + 'Index'
const obsoleteWorkflowIoToken = 'io' + 'Contract'
const obsoleteResolverToken = 'resolveEffectiveWorkflow' + 'IoContract'

test('WorkflowsPage keeps workflow tabs visible while refreshing the workflow list', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /\{!loading && \(/)
  assert.match(source, /Refreshing…/)
  assert.match(source, /workflows\.map\(\(wf\) =>/)
})


test('WorkflowsPage adds new edges without persisting obsolete edge ordering metadata', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /withStableTargetItemIndex/)
  assert.equal(source.includes(obsoleteEdgeOrderToken), false)
  assert.match(source, /addEdge\(\{ \.\.\.connection, \.\.\.DEFAULT_EDGE_OPTS \}/)
})

test('WorkflowsPage does not persist obsolete workflow metadata', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /function createWorkflowExtensionNode/)
  assert.equal(source.includes(obsoleteResolverToken), false)
  assert.equal(source.includes(obsoleteWorkflowIoToken), false)
  assert.match(source, /return createHydratedExtensionWorkflowNode\(args\)/)
  assert.equal(source.match(/createWorkflowExtensionNode\(\{/g)?.length, 2)
})

test('WorkflowsPage normalizes edges on workflow switch and when extension metadata arrives without remount regressions', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /import \{ normalizeWorkflowEdges \} from '\.\/workflowEdgeNormalization'/)
  assert.match(source, /const normalized = normalizeWorkflowEdges\(\{\s*nodes: workflow\.nodes,\s*edges: workflow\.edges,\s*allExtensions,/s)
  assert.match(source, /const nodesRef = useRef\(nodes\)/)
  assert.match(source, /const edgesRef = useRef\(edges\)/)
  assert.match(source, /skipPushRef\.current = true\s*\n\s*setEdges\(toFlowEdges\(normalized\.edges\)\)/)
  assert.match(source, /key=\{activeWorkflow\.id\}/)
})

test('WorkflowsPage source never disables Run because of semantic process validation', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.doesNotMatch(source, /validateWorkflowProcessRun/)
  assert.doesNotMatch(source, /setConnectionIssue\(runValidationIssue\)/)
  assert.doesNotMatch(source, /disabled=!isRunning && Boolean\(runValidationIssue\)/)
  assert.match(source, /title="Run workflow"/)
})
