import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import type { Workflow } from '@shared/types/electron.d'

const { resolveOpenWorkflows } = await import(new URL('./openWorkflows.ts', import.meta.url).href)

const sourcePath = path.join(import.meta.dirname, 'WorkflowsPage.tsx')
const obsoleteEdgeOrderToken = 'targetItem' + 'Index'
const obsoleteWorkflowIoToken = 'io' + 'Contract'
const obsoleteResolverToken = 'resolveEffectiveWorkflow' + 'IoContract'

function workflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    description: '',
    nodes: [],
    edges: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  }
}

test('resolveOpenWorkflows excludes closed workflows and preserves openIds order', () => {
  const first = workflow('first', 'First')
  const second = workflow('second', 'Second')
  const closed = workflow('closed', 'Closed')

  const result = resolveOpenWorkflows([closed, second, first], ['second', 'missing', 'first'])

  assert.deepEqual(result.map((item: Workflow) => item.id), ['second', 'first'])
})

test('WorkflowsPage keeps open tabs visible while refreshing the workflow list', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /Refreshing…/)
  assert.match(source, /const openWorkflows\s+=\s+useMemo\(\(\) => resolveOpenWorkflows\(workflows, openIds\), \[workflows, openIds\]\)/)
  assert.match(source, /\{openWorkflows\.map\(\(wf\) =>/)
})

test('WorkflowsPage canvas toolbar restores a visible New Workflow action wired to the page handler', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /workflow, allExtensions, onSave, panelOpen, onTogglePanel, onNew, onOpen, onImport/)
  assert.match(source, /onClick=\{onNew\}[\s\S]*<span className="text-sm font-medium">New Workflow<\/span>/)
  assert.match(source, /<WorkflowCanvasInner[\s\S]*onNew=\{handleCreateBlank\}/)
})

test('WorkflowsPage creates blank workflows by saving first and then opening exactly once', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /const handleCreateBlank = useCallback\(async \(\) => \{[\s\S]*const wf = newWorkflow\(\)[\s\S]*await save\(wf\)[\s\S]*openWorkflow\(wf\.id\)[\s\S]*\}, \[save, openWorkflow\]\)/)
  assert.doesNotMatch(source, /handleCreateBlank[\s\S]{0,220}setActive\(wf\.id\)/)
})

test('WorkflowsPage open actions still add and activate workflows, and empty state keeps New Workflow', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /onClick=\{\(\) => \{ openWorkflow\(wf\.id\); setOpenListVisible\(false\) \}\}/)
  assert.match(source, /<p className="text-sm font-medium">\{workflows\.length === 0 \? 'No workflows yet' : 'No workflow open'\}<\/p>/)
  assert.match(source, /<button onClick=\{handleCreateBlank\}[\s\S]*New Workflow[\s\S]*<\/button>/)
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

test('WorkflowsPage warns on preflight issues without blocking save and run', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /if \(preflightIssues\.length > 0\) \{\s*showToast\(preflightIssues\[0\]\.message\)\s*\}\s*const wf: Workflow/s)
  assert.match(source, /onSave\(wf\)\s*\n\s*runWorkflow\(wf, allExtensions\)/)
  assert.doesNotMatch(source, /if \(preflightIssues\.length > 0\) \{\s*showToast\(preflightIssues\[0\]\.message\)\s*return/s)
})
